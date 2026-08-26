/**
 * Machine probe.
 *
 * Setup needs to answer one question before an operator can serve anything:
 * how much memory can a model actually live in on this machine. Everything
 * here exists to produce that number on a machine nobody has seen, without
 * asking the operator to know their own VRAM.
 *
 * Every probe is best effort and every failure degrades to the next one, down
 * to "CPU only, size against system RAM", which is always answerable. Nothing
 * here throws.
 */
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

export type Gpu = {
  name: string;
  /** Total memory of the device in MiB. */
  vramMB: number;
  /** Where the number came from, so a wrong answer can be traced. */
  source: string;
};

export type Hardware = {
  platform: NodeJS.Platform;
  arch: string;
  cores: number;
  cpu: string;
  ramMB: number;
  gpus: Gpu[];
  /**
   * What a model may occupy, in MiB, and the reasoning behind it. This is the
   * only field the model picker reads.
   */
  budgetMB: number;
  budgetSource: string;
  /** Apple Silicon and integrated GPUs draw from system RAM, not a private pool. */
  unified: boolean;
};

const MB = 1024 * 1024;
const run = (cmd: string, args: string[], ms = 4000): string => {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: ms, windowsHide: true });
    return r.status === 0 ? (r.stdout ?? '').trim() : '';
  } catch { return ''; }
};

/**
 * NVIDIA. Present on every machine with a working driver, on all three
 * platforms, and it reports the number ollama will actually see.
 */
function nvidia(): Gpu[] {
  const out = run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (!out) return [];
  return out.split('\n').flatMap(line => {
    const [name, mem] = line.split(',').map(s => s.trim());
    const vramMB = Number(mem);
    return name && Number.isFinite(vramMB) && vramMB > 0
      ? [{ name, vramMB, source: 'nvidia-smi' }]
      : [];
  });
}

/**
 * AMD. rocm-smi is only present when ROCm is installed, so the sysfs node is
 * tried first: it exists on any kernel with amdgpu loaded, ROCm or not.
 */
function amd(): Gpu[] {
  const found: Gpu[] = [];
  const drm = '/sys/class/drm';
  if (existsSync(drm)) {
    for (const card of readdirSync(drm).filter(d => /^card\d+$/.test(d))) {
      const base = `${drm}/${card}/device`;
      try {
        const bytes = Number(readFileSync(`${base}/mem_info_vram_total`, 'utf8').trim());
        if (!Number.isFinite(bytes) || bytes <= 0) continue;
        let name = 'AMD GPU';
        try { name = readFileSync(`${base}/product_name`, 'utf8').trim() || name; } catch { /* older kernels */ }
        found.push({ name, vramMB: Math.round(bytes / MB), source: `sysfs ${card}` });
      } catch { /* not an amdgpu card */ }
    }
  }
  if (found.length) return found;

  const json = run('rocm-smi', ['--showmeminfo', 'vram', '--json']);
  if (!json) return [];
  try {
    const d = JSON.parse(json) as Record<string, Record<string, string>>;
    return Object.entries(d).flatMap(([card, v]) => {
      const bytes = Number(Object.entries(v).find(([k]) => /vram.*total/i.test(k))?.[1]);
      return Number.isFinite(bytes) && bytes > 0
        ? [{ name: `AMD ${card}`, vramMB: Math.round(bytes / MB), source: 'rocm-smi' }]
        : [];
    });
  } catch { return []; }
}

/**
 * Windows, for the non-NVIDIA case. AdapterRAM is a 32-bit field, so it tops
 * out at 4095 MB and lies about every card larger than that; the driver's
 * qwMemorySize in the registry is 64-bit and correct. Both are read and the
 * larger is kept, which is right whichever one is broken.
 */
function windows(): Gpu[] {
  const ps = (script: string) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 8000);
  const names = ps('(Get-CimInstance Win32_VideoController).Name -join "|"').split('|').map(s => s.trim()).filter(Boolean);
  if (!names.length) return [];
  const adapter = ps('(Get-CimInstance Win32_VideoController).AdapterRAM -join "|"')
    .split('|').map(s => Math.round(Number(s.trim()) / MB));
  const qw = ps(
    'Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*" ' +
    '-Name "HardwareInformation.qwMemorySize" -EA 0 | % { $_."HardwareInformation.qwMemorySize" } | % { $_ } ',
  ).split('\n').map(s => Math.round(Number(s.trim()) / MB));
  return names.map((name, i) => {
    const vramMB = Math.max(adapter[i] || 0, qw[i] || 0);
    return { name, vramMB, source: vramMB === (qw[i] || 0) ? 'registry qwMemorySize' : 'Win32_VideoController' };
  }).filter(g => g.vramMB > 0);
}

/**
 * Apple Silicon. There is no separate VRAM: the GPU addresses system RAM, and
 * macOS caps what it will hand to one process (about 75% of RAM below 36 GB,
 * a little more above). That cap, not the total, is what a model has to fit in.
 */
function apple(ramMB: number): Gpu[] {
  const chip = run('sysctl', ['-n', 'machdep.cpu.brand_string']) || 'Apple Silicon';
  const share = ramMB <= 36 * 1024 ? 0.75 : 0.8;
  return [{ name: chip, vramMB: Math.floor(ramMB * share), source: 'unified memory' }];
}

export function probeHardware(): Hardware {
  const platform = process.platform;
  const ramMB = Math.round(os.totalmem() / MB);
  const cpus = os.cpus();
  const unified = platform === 'darwin' && process.arch === 'arm64';

  let gpus = nvidia();
  if (!gpus.length && unified) gpus = apple(ramMB);
  if (!gpus.length && platform === 'linux') gpus = amd();
  if (!gpus.length && platform === 'win32') gpus = windows();

  // Ollama does not split one model across two devices by default, so the
  // budget is the largest single GPU rather than the sum.
  const best = gpus.reduce<Gpu | null>((a, b) => (a && a.vramMB >= b.vramMB ? a : b), null);

  let budgetMB: number;
  let budgetSource: string;
  if (best && !unified) {
    // Leave the desktop compositor and whatever else holds a context its room.
    // A model sized to the last megabyte of a display GPU spills the moment a
    // browser opens.
    budgetMB = Math.floor(best.vramMB * 0.9);
    budgetSource = `${best.name}, ${best.vramMB} MiB VRAM, 90% usable`;
  } else if (best && unified) {
    budgetMB = best.vramMB;
    budgetSource = `${best.name}, ${ramMB} MiB unified memory`;
  } else {
    // CPU inference. Half of RAM, because the operator is still using the
    // machine and swapping a model is worse than not serving it.
    budgetMB = Math.floor(ramMB * 0.5);
    budgetSource = `no GPU detected, half of ${ramMB} MiB system RAM`;
  }

  return {
    platform, arch: process.arch, cores: cpus.length,
    cpu: cpus[0]?.model?.trim() ?? 'unknown CPU',
    ramMB, gpus, budgetMB, budgetSource, unified,
  };
}

/** One line for the on-chain provider record and for setup's output. */
export function describeHardware(hw: Hardware): string {
  const gpu = hw.gpus.length
    ? hw.gpus.map(g => `${g.name} ${Math.round(g.vramMB / 1024)}GB`).join(' + ')
    : 'CPU-only';
  return `${gpu} | ${hw.cores} cores | ${Math.round(hw.ramMB / 1024)}GB | ${os.hostname()}`;
}
