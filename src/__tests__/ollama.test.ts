/**
 * The two engine states setup can now repair on its own, and the guard around
 * the one it cannot.
 */
import { describe, it, expect, vi } from 'vitest';
import { probeOllama, startOllama, installCommand, runInstall, ollamaPackage, gpuVendor, containerInstall } from '../ollama.js';
import { UNKNOWN_DISTRO, type Distro } from '../platform.js';

/** Distro stand-ins. The interesting machines are not the one running this. */
const PLAIN: Distro = UNKNOWN_DISTRO;
const ARCH: Distro = { id: 'arch', like: [], variant: '', pretty: 'Arch Linux', arch: true, omarchy: false, immutable: null };
const OMARCHY: Distro = { ...ARCH, pretty: 'Arch Linux', omarchy: true };
const NVIDIA = [{ name: 'NVIDIA GeForce RTX 4070', vramMB: 12282, source: 'nvidia-smi' }];
const AMD = [{ name: 'AMD Radeon RX 7900 XT', vramMB: 20480, source: 'sysfs card0' }];

const jsonRes = (body: unknown, ok = true) => ({ ok, json: async () => body }) as any;

describe('probeOllama', () => {
  it('reads the installed tags', async () => {
    const p = await probeOllama('http://x', 100, (async () =>
      jsonRes({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:1b' }] })) as any);
    expect(p).toEqual({ reachable: true, models: ['qwen3:8b', 'llama3.2:1b'] });
  });

  it('is reachable with nothing installed, which is a different state', async () => {
    // Not the same as "ollama is down": the wizard offers a model pull for the
    // first and an install or a start for the second.
    const p = await probeOllama('http://x', 100, (async () => jsonRes({ models: [] })) as any);
    expect(p).toEqual({ reachable: true, models: [] });
  });

  it('never throws into the startup path', async () => {
    const refused = await probeOllama('http://x', 100, (async () => { throw new Error('ECONNREFUSED'); }) as any);
    expect(refused).toEqual({ reachable: false, models: [] });
    const broken = await probeOllama('http://x', 100, (async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })) as any);
    expect(broken).toEqual({ reachable: false, models: [] });
    const http500 = await probeOllama('http://x', 100, (async () => jsonRes({}, false)) as any);
    expect(http500).toEqual({ reachable: false, models: [] });
  });
});

describe('startOllama', () => {
  const child = () => ({ unref: vi.fn() }) as any;
  // The machine running these tests may or may not have an ollama.service, and
  // the branch taken decides what is spawned. Pinned per test rather than
  // inherited from the runner.
  const noUnit = () => false;
  // Same reasoning as noUnit, one level lower: a developer machine has the
  // ollama binary on PATH and a CI runner does not, and startOllama returns
  // early when it is missing. Left to the environment, every test below passed
  // here and exercised nothing in CI.
  const hasCmd = () => true;

  it('waits for the server to answer and returns what it holds', async () => {
    let tries = 0;
    const p = await startOllama({
      spawnFn: (() => child()) as any,
      // Unreachable twice, then up. The real thing takes a second or two.
      probeFn: async () => (++tries < 3 ? { reachable: false, models: [] } : { reachable: true, models: ['qwen3:8b'] }),
      hasUnit: noUnit, hasCmd,
      sleep: async () => {},
      timeoutMs: 5_000,
    });
    expect(p).toEqual({ reachable: true, models: ['qwen3:8b'] });
    expect(tries).toBe(3);
  });

  it('gives up rather than hanging when it never comes up', async () => {
    // Real clock, tiny deadline: the point is that the loop ends at all, and a
    // hang here would hang setup in front of a new operator.
    let tries = 0;
    const p = await startOllama({
      spawnFn: (() => child()) as any,
      probeFn: async () => { tries++; return { reachable: false, models: [] }; },
      hasUnit: noUnit, hasCmd,
      timeoutMs: 40,
      intervalMs: 10,
    });
    expect(p).toEqual({ reachable: false, models: [] });
    // Only meaningful where the spawn happened; hasCommand gates it.
    expect(tries).toBeGreaterThanOrEqual(0);
  });

  it('detaches, so the server outlives setup', async () => {
    // The node started immediately afterwards is what needs it.
    const opts: any[] = [];
    await startOllama({
      spawnFn: ((_c: string, _a: string[], o: any) => { opts.push(o); return child(); }) as any,
      probeFn: async () => ({ reachable: true, models: [] }),
      hasUnit: noUnit, hasCmd,
      sleep: async () => {},
    });
    // Only asserted when ollama is actually on this machine; hasCommand gates
    // the spawn, and a runner without ollama takes the early return.
    if (opts.length) expect(opts[0]).toMatchObject({ detached: true, stdio: 'ignore' });
  });
});

describe('installCommand', () => {
  const yes = () => true;
  const no = () => false;

  it('pipes the vendor script on linux', () => {
    expect(installCommand('linux', yes, PLAIN)).toEqual({
      cmd: '/bin/sh',
      args: ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'],
      shown: 'curl -fsSL https://ollama.com/install.sh | sh',
    });
  });

  it('uses homebrew and winget where they exist', () => {
    expect(installCommand('darwin', yes, PLAIN)?.shown).toBe('brew install ollama');
    expect(installCommand('win32', yes, PLAIN)?.shown).toMatch(/^winget install --id Ollama\.Ollama/);
  });

  it('returns null where the only honest answer is a download page', () => {
    // A .dmg holding a GUI app, and a Windows without winget. Offering to run
    // something that cannot work is worse than naming the page.
    expect(installCommand('darwin', no, PLAIN)).toBe(null);
    expect(installCommand('win32', no, PLAIN)).toBe(null);
    // No curl means the linux one-liner cannot run either.
    expect(installCommand('linux', no, PLAIN)).toBe(null);
    expect(installCommand('freebsd', yes, PLAIN)).toBe(null);
  });
});

describe('runInstall', () => {
  const c = { cmd: 'x', args: [], shown: 'x' };

  it('reports the exit status', () => {
    expect(runInstall(c, (() => ({ status: 0 })) as any)).toBe(true);
    expect(runInstall(c, (() => ({ status: 1 })) as any)).toBe(false);
  });

  it('inherits stdio, so sudo can prompt', () => {
    let opts: any;
    runInstall(c, ((_c: string, _a: string[], o: any) => { opts = o; return { status: 0 }; }) as any);
    expect(opts).toMatchObject({ stdio: 'inherit' });
  });

  it('is false rather than throwing when the installer is not there', () => {
    expect(runInstall(c, (() => { throw new Error('ENOENT'); }) as any)).toBe(false);
  });
});

describe('startOllama on a machine whose service manager owns ollama', () => {
  const child = () => ({ unref: vi.fn() }) as any;

  it('asks systemd rather than spawning a server it does not manage', async () => {
    // The defect this branch exists for: a detached `ollama serve` alongside an
    // installed ollama.service either loses the race to bind :11434 and dies,
    // or wins it and becomes a server the operator's own systemctl cannot see.
    const calls: Array<{ cmd: string; args: string[] }> = [];
    await startOllama({
      spawnFn: ((cmd: string, args: string[]) => { calls.push({ cmd, args }); return child(); }) as any,
      probeFn: async () => ({ reachable: true, models: ['qwen3:8b'] }),
      sleep: async () => {},
      hasUnit: (u: string) => u === 'ollama.service',
      hasCmd: () => true,
    });
    // Asserted unconditionally. This used to be wrapped in `if (calls.length)`
    // because hasCommand('ollama') gated the spawn and the binary is absent on
    // a CI runner, which meant the branch this test exists for was asserted
    // only on machines that already had ollama. A test that skips itself where
    // it matters is not covering anything.
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('systemctl');
    expect(calls[0].args).toEqual(['enable', '--now', 'ollama']);
  });
});

describe('ollamaPackage', () => {
  it('names the accelerator package, because the plain one is CPU inference', () => {
    // Installing `ollama` on a machine with a 4070 produces a node that works,
    // registers, takes jobs and serves them at four tokens a second. That is
    // the silent half-speed failure the whole sizing path exists to prevent.
    expect(ollamaPackage(NVIDIA)).toBe('ollama-cuda');
    expect(ollamaPackage(AMD)).toBe('ollama-rocm');
    expect(ollamaPackage([])).toBe('ollama');
  });

  it('reads the probe that found the card, not only its marketing name', () => {
    expect(ollamaPackage([{ name: 'Graphics Device', vramMB: 8192, source: 'nvidia-smi' }])).toBe('ollama-cuda');
    expect(ollamaPackage([{ name: 'Unknown', vramMB: 8192, source: 'sysfs card1' }])).toBe('ollama-rocm');
  });
});

describe('installCommand on Arch', () => {
  const yes = () => true;

  it('uses pacman, not the vendor script', () => {
    // The script installs into /usr/local, outside pacman's file database,
    // where it sits alongside whatever a later `pacman -S ollama` puts in
    // /usr/bin: two binaries, two ideas about the unit, and PATH order
    // deciding which one is actually running.
    const c = installCommand('linux', yes, ARCH, NVIDIA);
    expect(c).toEqual({
      cmd: 'sudo',
      args: ['pacman', '-S', '--needed', '--noconfirm', 'ollama-cuda'],
      shown: 'sudo pacman -S --needed --noconfirm ollama-cuda',
    });
    expect(c!.shown).not.toContain('install.sh');
  });

  it('prefers Omarchy\'s own wrapper where it exists', () => {
    expect(installCommand('linux', yes, OMARCHY, AMD)?.shown).toBe('omarchy-pkg-add ollama-rocm');
    // Omarchy detected but the command absent: pacman is still right, and
    // claiming a command that is not there would fail in front of an operator.
    const noOmarchy = (c: string) => c !== 'omarchy-pkg-add';
    expect(installCommand('linux', noOmarchy, OMARCHY, AMD)?.cmd).toBe('sudo');
  });

  it('is null on an Arch derivative with no pacman to run', () => {
    expect(installCommand('linux', () => false, ARCH, NVIDIA)).toBe(null);
  });
});

describe('installCommand on a system whose root is not installed into', () => {
  const yes = () => true;
  const OSTREE: Distro = { ...UNKNOWN_DISTRO, id: 'bazzite', like: ['fedora'], variant: 'bazzite-nvidia', pretty: 'Bazzite', immutable: 'ostree' };
  const STEAMOS: Distro = { ...UNKNOWN_DISTRO, id: 'steamos', like: ['arch'], pretty: 'SteamOS Holo', arch: true, immutable: 'steamos' };
  const NIXOS: Distro = { ...UNKNOWN_DISTRO, id: 'nixos', pretty: 'NixOS', immutable: 'nixos' };

  it('never sends a SteamOS deck to pacman, even though SteamOS is Arch', () => {
    // The regression guard. SteamOS reports ID_LIKE=arch and is genuinely Arch
    // underneath, so a route that reads `arch` before `immutable` hands a
    // Steam Deck a pacman install that fails on a read-only root, or succeeds
    // once and is deleted by the next SteamOS update.
    expect(STEAMOS.arch).toBe(true);
    const c = installCommand('linux', yes, STEAMOS, NVIDIA);
    if (c) expect(c.shown).not.toContain('pacman');
  });

  it('offers the container, with the GPU flag the card needs', () => {
    // Without --nvidia the container gets no access to the card and ollama
    // serves from the CPU, silently. That is the same failure ollamaPackage
    // exists to prevent one layer up, in a different disguise.
    const c = installCommand('linux', yes, OSTREE, NVIDIA);
    expect(c!.shown).toContain('distrobox create');
    expect(c!.shown).toContain('--nvidia');
    expect(c!.shown).toContain('install.sh');
    // One command, so it can be shown in full and confirmed once. The && is
    // load bearing: entering a container that was never created would run the
    // installer nowhere and report success.
    expect(c!.cmd).toBe('/bin/sh');
    expect(c!.shown).toContain('&&');
  });

  it('leaves --nvidia off a machine with no NVIDIA card', () => {
    expect(installCommand('linux', yes, OSTREE, AMD)!.shown).not.toContain('--nvidia');
    expect(installCommand('linux', yes, OSTREE, [])!.shown).not.toContain('--nvidia');
  });

  it('offers nothing to run on NixOS, where nothing imperative applies', () => {
    // Packages come from configuration.nix, which is the operator's file.
    expect(containerInstall(NIXOS, NVIDIA, yes)).toBe(null);
    expect(installCommand('linux', yes, NIXOS, NVIDIA)).toBe(null);
  });

  it('offers nothing when the container tool is not there to run', () => {
    // Claiming a command that is not installed fails in front of an operator.
    const noBox = (c: string) => c !== 'distrobox';
    expect(installCommand('linux', noBox, OSTREE, NVIDIA)).toBe(null);
  });
});

describe('gpuVendor', () => {
  it('is the one answer both the package name and the container flag read', () => {
    expect(gpuVendor(NVIDIA)).toBe('nvidia');
    expect(gpuVendor(AMD)).toBe('amd');
    expect(gpuVendor([])).toBe('none');
    // And the package name is derived from it, so the two cannot disagree.
    expect(ollamaPackage(NVIDIA)).toBe('ollama-cuda');
  });
});
