/**
 * The engine, started and if necessary installed.
 *
 * setup.ts knew both of ollama's failure shapes and printed the right command
 * for each: "it is installed but not running: ollama serve", and "install it
 * from ollama.com/download". Both are things this process can do rather than
 * say, and every step an operator has to perform by hand between cloning and
 * earning is a step some operators stop at.
 *
 * What it cannot do is install node. This file runs ON node, so a machine
 * without one never reaches this code. That gap closes with a packaged
 * runtime, not with a guard.
 *
 * Nothing here throws and nothing here is silent: an operator who declines is
 * left with exactly the machine they had, and told what to run themselves.
 */
import { spawn, spawnSync, type spawnSync as SpawnSync } from 'node:child_process';
import { hasCommand, detectDistro, hasSystemdUnit, type Distro } from './platform.js';
import type { Gpu } from './hardware.js';

/**
 * Where ollama answers. Hardcoded to match src/host.ts and src/engines.ts,
 * which do the same. OLLAMA_HOST is deliberately not read here: it is a
 * host:port with no scheme as often as it is a URL, and a half-correct parse
 * of it would send this probe somewhere the node then does not talk to.
 */
export const OLLAMA_URL = 'http://localhost:11434';

export type Probe = { reachable: boolean; models: string[] };

/** Is ollama answering, and what does it hold. Never throws. */
export async function probeOllama(url = OLLAMA_URL, timeoutMs = 4000, fetchFn: typeof fetch = fetch): Promise<Probe> {
  try {
    const r = await fetchFn(`${url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { reachable: false, models: [] };
    const body = await r.json() as any;
    return { reachable: true, models: (body?.models ?? []).map((m: any) => m.name).filter(Boolean) };
  } catch {
    return { reachable: false, models: [] };
  }
}

export type StartOptions = {
  url?: string;
  /** How long to keep asking before giving up on it. */
  timeoutMs?: number;
  intervalMs?: number;
  log?: (line: string) => void;
  spawnFn?: typeof spawn;
  probeFn?: (url: string, timeoutMs: number) => Promise<Probe>;
  sleep?: (ms: number) => Promise<void>;
  /** Whether a systemd unit of that name exists. Injected for the tests, which
   *  have to exercise the branch this machine is not on. */
  hasUnit?: (unit: string) => boolean;
  /** Whether a command is on PATH. Injected for the same reason as `hasUnit`,
   *  and for a sharper one: a developer machine has ollama installed and a CI
   *  runner does not, so leaving this to the environment meant every test
   *  below passed locally and returned early in CI without running the branch
   *  it was written for. Found by the first run of the verify workflow. */
  hasCmd?: (cmd: string) => boolean;
};

const nap = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Start `ollama serve` and wait for it to answer.
 *
 * Detached and unref'd on purpose: the server has to outlive setup, because
 * the node started immediately afterwards is what needs it. That does mean
 * leaving a process behind, which is why it is announced rather than done
 * quietly, and why it is only ever reached when the operator has already
 * installed ollama and simply has not started it.
 *
 * On Windows the ordinary install is a tray app; `ollama serve` from a
 * terminal works there too, and is what runs when the app is not up.
 */
export async function startOllama(opts: StartOptions = {}): Promise<Probe> {
  const {
    url = OLLAMA_URL, timeoutMs = 20_000, intervalMs = 500,
    log = () => {}, spawnFn = spawn, probeFn = probeOllama, sleep = nap,
    hasUnit = hasSystemdUnit, hasCmd = hasCommand,
  } = opts;

  if (!hasCmd('ollama')) return { reachable: false, models: [] };

  // Where a service manager owns this daemon, ask the service manager. Arch's
  // ollama package ships ollama.service, and on those machines a spawned
  // `ollama serve` either loses the race to bind :11434 and dies, or wins it
  // and leaves a server that the operator's own `systemctl status ollama` does
  // not show and `systemctl restart ollama` does not restart. Neither failure
  // announces itself.
  //
  // `--now` on enable rather than a bare start: an operator setting up a node
  // wants the engine back after a reboot, and this is the one moment where
  // saying so costs nothing.
  const unit = hasUnit('ollama.service');
  try {
    if (unit) {
      const r = spawnFn('systemctl', ['enable', '--now', 'ollama'], { stdio: 'inherit' });
      // Fire and forget is not available here: systemctl returns immediately
      // on success but the socket is not up yet, which is what the poll below
      // is for. A failure to become root, though, is worth saying out loud
      // rather than leaving as twenty seconds of silent polling.
      await new Promise<void>(res => {
        (r as any).on?.('exit', (code: number) => {
          if (code !== 0) log(`systemctl enable --now ollama exited ${code}`);
          res();
        });
        if (!(r as any).on) res();
      });
      log('asked systemd to start ollama');
    } else {
      const child = spawnFn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref?.();
      log('started ollama in the background');
    }
  } catch (e: any) {
    log(`could not start ollama: ${e?.message ?? e}`);
    return { reachable: false, models: [] };
  }

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(intervalMs);
    const p = await probeFn(url, 2000);
    if (p.reachable) return p;
  }
  return { reachable: false, models: [] };
}

export type InstallCommand = { cmd: string; args: string[]; shown: string };

/**
 * Which ollama package this machine wants, on distributions that ship more
 * than one.
 *
 * Arch splits the runtime by accelerator, and the split is not cosmetic: the
 * plain `ollama` package is CPU inference. An operator with a 4090 who
 * installs it gets a node that works, registers on chain, takes jobs and
 * serves them at four tokens a second, which is the exact silent half-speed
 * failure the model sizing in models.ts exists to prevent. Getting this wrong
 * is worse than not installing at all.
 *
 * Vendor is read from what hardware.ts already probed rather than probed
 * again, so there is one answer to "what card is in this machine" per run.
 */
export function gpuVendor(gpus: Gpu[] = []): 'nvidia' | 'amd' | 'none' {
  // `source` is the probe that found the card, and it names the vendor more
  // reliably than the marketing string in `name` does.
  if (gpus.some(g => g.source === 'nvidia-smi' || /nvidia|geforce|rtx|quadro|tesla/i.test(g.name))) return 'nvidia';
  if (gpus.some(g => g.source.startsWith('sysfs') || g.source === 'rocm-smi' || /\bamd\b|radeon/i.test(g.name))) return 'amd';
  return 'none';
}

export function ollamaPackage(gpus: Gpu[] = []): 'ollama-cuda' | 'ollama-rocm' | 'ollama' {
  const v = gpuVendor(gpus);
  return v === 'nvidia' ? 'ollama-cuda' : v === 'amd' ? 'ollama-rocm' : 'ollama';
}

/**
 * The container route, for a system whose root cannot be installed into.
 *
 * One command rather than two, in the same shape as the vendor script's
 * `curl | sh`, so it can be shown in full and confirmed once. The `&&` matters:
 * entering a container that was never created would otherwise run the
 * installer nowhere and report success.
 *
 * Null on the systems where no single command is honest. On NixOS the packages
 * come from a file the operator owns, and on SteamOS distrobox is not
 * preinstalled, so there is nothing here to offer running; `immutableHint`
 * says what to do instead.
 *
 * Whether the container can reach the GPU is decided by one flag, and getting
 * it wrong produces an ollama that works, registers, takes jobs and serves
 * them from the CPU without ever saying so.
 */
export function containerInstall(
  distro: Distro,
  gpus: Gpu[] = [],
  hasCmd: (c: string) => boolean = hasCommand,
): InstallCommand | null {
  if (distro.immutable === 'nixos') return null;
  if (!hasCmd('distrobox')) return null;

  const nvidia = gpuVendor(gpus) === 'nvidia' ? ' --nvidia' : '';
  const script =
    `distrobox create --name dinnernode --image fedora:latest${nvidia} --yes && ` +
    `distrobox enter dinnernode -- sh -c 'curl -fsSL https://ollama.com/install.sh | sh'`;
  return { cmd: '/bin/sh', args: ['-c', script], shown: script };
}

/**
 * How to install ollama on this machine, when there is a route that can be run
 * unattended-but-confirmed. Null where the only honest answer is a download
 * page, which is macOS without homebrew (a .dmg holding a GUI app) and Windows
 * without winget.
 *
 * On Arch the package manager owns this, and the vendor script does not. The
 * script installs into /usr/local, outside pacman's file database, where it
 * sits alongside whatever `pacman -S ollama` later puts in /usr/bin: two
 * binaries, two ideas about the systemd unit, and a PATH order deciding which
 * one an operator is actually running. Neither ever gets upgraded with the
 * rest of the system. So Arch and its derivatives get pacman, with the GPU
 * package `ollamaPackage` chose.
 *
 * Everywhere else on Linux the route pipes a vendor script into a shell, which
 * is what Ollama publishes and what its own documentation tells people to run.
 * Both are shown in full and confirmed before they run, never assumed from
 * --yes, because a command that escalates to root is not something to start on
 * someone's behalf.
 */
export function installCommand(
  platform: NodeJS.Platform = process.platform,
  hasCmd: (c: string) => boolean = hasCommand,
  distro: Distro = detectDistro(),
  gpus: Gpu[] = [],
): InstallCommand | null {
  if (platform === 'linux') {
    // Before the Arch branch. SteamOS is Arch underneath and says so in
    // ID_LIKE, and a pacman install there fails on a read-only root or, worse,
    // succeeds after the operator disables the read-only flag and is then
    // deleted by the next SteamOS update, leaving a node that worked once.
    if (distro.immutable) return containerInstall(distro, gpus, hasCmd);
    if (distro.arch) {
      const pkg = ollamaPackage(gpus);
      // Omarchy ships its own wrapper, which is `pacman -S --noconfirm
      // --needed` plus a check that the package really landed. Preferred where
      // it exists because it is the command that machine's own scripts use,
      // and an operator reading their shell history should see one convention
      // rather than two.
      if (distro.omarchy && hasCmd('omarchy-pkg-add')) {
        return { cmd: 'omarchy-pkg-add', args: [pkg], shown: `omarchy-pkg-add ${pkg}` };
      }
      if (!hasCmd('pacman')) return null;
      const args = ['pacman', '-S', '--needed', '--noconfirm', pkg];
      return { cmd: 'sudo', args, shown: `sudo ${args.join(' ')}` };
    }
    if (!hasCmd('curl')) return null;
    const script = 'curl -fsSL https://ollama.com/install.sh | sh';
    return { cmd: '/bin/sh', args: ['-c', script], shown: script };
  }
  if (platform === 'darwin') {
    if (!hasCmd('brew')) return null;
    return { cmd: 'brew', args: ['install', 'ollama'], shown: 'brew install ollama' };
  }
  if (platform === 'win32') {
    if (!hasCmd('winget')) return null;
    const args = ['install', '--id', 'Ollama.Ollama', '-e', '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements'];
    return { cmd: 'winget', args, shown: `winget ${args.join(' ')}` };
  }
  return null;
}

/**
 * Run an install command, inheriting stdio so sudo can prompt and the progress
 * bar is visible. Returns whether it exited cleanly; the caller still has to
 * probe, because an installer that succeeds has not necessarily started a
 * server.
 */
export function runInstall(c: InstallCommand, spawnFn: typeof SpawnSync = spawnSync): boolean {
  try {
    return spawnFn(c.cmd, c.args, { stdio: 'inherit' }).status === 0;
  } catch {
    return false;
  }
}
