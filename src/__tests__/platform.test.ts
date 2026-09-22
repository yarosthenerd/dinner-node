/**
 * The win32 branches, exercised on whatever platform the suite runs on.
 *
 * These are the two functions that were broken on Windows and produced no
 * error while being broken, so the tests assert the mechanism rather than the
 * result: which lookup command is spawned, and what shape of path comes back.
 */
import { describe, it, expect, vi } from 'vitest';
import { hasCommand, repoEnvPath, detectDistro, installHint, immutableHint, ollamaServeHint, UNKNOWN_DISTRO, type Distro } from '../platform.js';

/** A spawnSync stand-in that records its call and returns a fixed status. */
function fakeSpawn(status: number | null, error?: NodeJS.ErrnoException) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { status, error } as any;
  }) as any;
  return { fn, calls };
}

const onWin = process.platform === 'win32';

describe('hasCommand', () => {
  it('uses the platform lookup tool, never `command -v` on win32', () => {
    const { fn, calls } = fakeSpawn(0);
    hasCommand('ollama', fn);
    expect(calls).toHaveLength(1);
    if (onWin) {
      expect(calls[0].cmd).toBe('where');
      expect(calls[0].args).toEqual(['ollama']);
    } else {
      expect(calls[0].cmd).toBe('/bin/sh');
      expect(calls[0].args).toEqual(['-c', 'command -v "$1"', 'sh', 'ollama']);
    }
  });

  it('is true on status 0 and false on anything else', () => {
    expect(hasCommand('x', fakeSpawn(0).fn)).toBe(true);
    expect(hasCommand('x', fakeSpawn(1).fn)).toBe(false);
    expect(hasCommand('x', fakeSpawn(null).fn)).toBe(false);
  });

  it('claims nothing when the lookup tool itself is missing', () => {
    // `where` absent from a stripped Windows, or no shell. The old code could
    // not tell this apart from "the command is not installed", which is how it
    // reported every command on win32 as missing.
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    expect(hasCommand('ollama', fakeSpawn(null, err).fn)).toBe(false);
  });

  it('finds a command that really is on this machine', () => {
    // An end-to-end check against the real spawnSync, so the branch that runs
    // in production is the one under test at least once. node is running us.
    expect(hasCommand('node')).toBe(true);
    expect(hasCommand('dinnernode-no-such-binary-9f3a')).toBe(false);
  });
});

describe('repoEnvPath', () => {
  it('returns a native absolute path, not a URL pathname', () => {
    const p = repoEnvPath(import.meta.url);
    expect(p.endsWith('.env')).toBe(true);
    if (onWin) {
      // The bug: `new URL(...).pathname` gives `/C:/Users/x/.env`, which
      // existsSync reports as absent, so setup read no config and generated a
      // fresh wallet on every run.
      expect(p).not.toMatch(/^\//);
      expect(p).toMatch(/^[A-Za-z]:\\/);
    } else {
      expect(p.startsWith('/')).toBe(true);
    }
  });

  it('resolves to the repo root, one level above the module', () => {
    // Called with a URL inside src/__tests__, so two levels up rather than one.
    const p = repoEnvPath(import.meta.url);
    expect(p).toContain('src');
  });
});

/**
 * os-release, as the three machines that matter here write it. Verbatim shapes
 * rather than a minimal fixture, because the parser's job is to survive the
 * quoting and the extra keys real files carry.
 */
const ARCH_RELEASE = `NAME="Arch Linux"
PRETTY_NAME="Arch Linux"
ID=arch
BUILD_ID=rolling
ANSI_COLOR="38;2;23;147;209"
HOME_URL="https://archlinux.org/"
`;
const CACHY_RELEASE = `NAME="CachyOS Linux"
PRETTY_NAME="CachyOS"
ID=cachyos
ID_LIKE="arch"
BUILD_ID=rolling
`;
const MINT_RELEASE = `NAME="Linux Mint"
VERSION="22.3 (Zena)"
ID=linuxmint
ID_LIKE="ubuntu debian"
PRETTY_NAME="Linux Mint 22.3"
`;

const read = (body: string) => () => body;
const missing = () => { throw new Error('ENOENT'); };

describe('detectDistro', () => {
  it('reads ID and unquotes PRETTY_NAME', () => {
    const d = detectDistro({ platform: 'linux', readFile: read(ARCH_RELEASE), exists: () => false, env: {} });
    expect(d.id).toBe('arch');
    expect(d.pretty).toBe('Arch Linux');
    expect(d.arch).toBe(true);
    expect(d.omarchy).toBe(false);
  });

  it('counts an Arch derivative as Arch, via ID_LIKE', () => {
    // EndeavourOS, CachyOS and Manjaro all identify this way, and pacman is
    // the right route on every one of them.
    const d = detectDistro({ platform: 'linux', readFile: read(CACHY_RELEASE), exists: () => false, env: {} });
    expect(d.id).toBe('cachyos');
    expect(d.arch).toBe(true);
  });

  it('does not mistake a Debian derivative for Arch', () => {
    const d = detectDistro({ platform: 'linux', readFile: read(MINT_RELEASE), exists: () => false, env: {} });
    expect(d.arch).toBe(false);
    expect(d.like).toEqual(['ubuntu', 'debian']);
  });

  it('finds Omarchy by its own environment variable, and by its directory', () => {
    const byEnv = detectDistro({
      platform: 'linux', readFile: read(ARCH_RELEASE),
      exists: (p: string) => p === '/home/o/.local/share/omarchy',
      env: { OMARCHY_PATH: '/home/o/.local/share/omarchy' },
    });
    expect(byEnv.omarchy).toBe(true);

    // A non-login shell where the export has not happened but the install has.
    const byDir = detectDistro({
      platform: 'linux', readFile: read(ARCH_RELEASE),
      exists: (p: string) => p === '/home/o/.local/share/omarchy',
      env: { HOME: '/home/o' },
    });
    expect(byDir.omarchy).toBe(true);
  });

  it('claims nothing where there is nothing to read', () => {
    // A container with no os-release, and every non-Linux platform. Unknown
    // routes to the download link, which works everywhere.
    expect(detectDistro({ platform: 'linux', readFile: missing, exists: () => false, env: {} })).toMatchObject({ id: '', arch: false });
    expect(detectDistro({ platform: 'win32', readFile: read(ARCH_RELEASE), exists: () => true, env: {} })).toEqual(UNKNOWN_DISTRO);
  });
});

describe('installHint', () => {
  const arch: Distro = { id: 'arch', like: [], variant: '', pretty: 'Arch Linux', arch: true, omarchy: false, immutable: null };
  const omarchy: Distro = { ...arch, omarchy: true };

  it('names the three ollama packages on Arch, and the unit that starts it', () => {
    const h = installHint('ollama', arch, 'linux').join('\n');
    expect(h).toContain('sudo pacman -S --needed ollama-cuda');
    expect(h).toContain('ollama-rocm');
    expect(h).toContain('systemctl enable --now ollama');
    // The vendor script is the wrong answer here, and its absence is the point.
    expect(h).not.toContain('install.sh');
  });

  it('speaks Omarchy\'s own command on Omarchy', () => {
    expect(installHint('ollama', omarchy, 'linux')[0]).toContain('omarchy-pkg-add ollama-cuda');
    expect(installHint('cloudflared', omarchy, 'linux')).toEqual(['omarchy-pkg-add cloudflared']);
  });

  it('keeps the vendor script everywhere else on linux', () => {
    expect(installHint('ollama', UNKNOWN_DISTRO, 'linux')).toEqual(['curl -fsSL https://ollama.com/install.sh | sh']);
  });

  it('names no package manager for LM Studio, on any platform', () => {
    // It ships as a desktop app with its own updater, and the third-party
    // packages that exist are not ones this file can promise are current.
    for (const p of ['linux', 'darwin', 'win32'] as NodeJS.Platform[]) {
      expect(installHint('lmstudio', arch, p).join('\n')).toContain('https://lmstudio.ai/download');
    }
  });
});

describe('ollamaServeHint', () => {
  it('names the unit where one exists, and the command where it does not', () => {
    // Telling an operator to run `ollama serve` on a machine with the unit
    // installed produces a server their own service manager does not know
    // about, which is the state that is hardest to debug later.
    expect(ollamaServeHint('linux', () => true)).toContain('systemctl enable --now ollama');
    expect(ollamaServeHint('linux', () => false)).toContain('ollama serve');
    expect(ollamaServeHint('win32', () => true)).toContain('Start menu');
  });
});

/**
 * The machines where every install route this repo knew was wrong, and which
 * are also, by definition, discrete GPUs sitting idle most of the day.
 *
 * Fixtures taken from what each system really writes. Bazzite's own
 * build_files/image-info rewrites ID to the image name with ID_LIKE=fedora;
 * Silverblue leaves ID=fedora and names itself in VARIANT_ID; SteamOS reports
 * ID_LIKE=arch and is the reason `immutable` is checked before `arch`.
 */
const BAZZITE_RELEASE = `NAME="Bazzite"
ID=bazzite
ID_LIKE="fedora"
VERSION_ID=41
VARIANT_ID=bazzite-nvidia
PRETTY_NAME="Bazzite"
`;
const SILVERBLUE_RELEASE = `NAME="Fedora Linux"
ID=fedora
VERSION_ID=41
VARIANT_ID=silverblue
PRETTY_NAME="Fedora Linux 41 (Silverblue)"
`;
const STEAMOS_RELEASE = `NAME="SteamOS"
ID=steamos
ID_LIKE=arch
VERSION_ID=3.6.20
PRETTY_NAME="SteamOS Holo"
`;
const NIXOS_RELEASE = `NAME=NixOS
ID=nixos
VERSION_ID="25.05"
PRETTY_NAME="NixOS 25.05 (Warbler)"
`;

describe('detectDistro on a system whose root is not installed into', () => {
  const at = (body: string, files: string[] = []) => detectDistro({
    platform: 'linux', readFile: read(body), exists: (p: string) => files.includes(p), env: {},
  });

  it('finds an ostree system by its boot marker, whatever it calls itself', () => {
    // The one signal here that cannot be wrong: written by the initramfs of a
    // booted ostree deployment. A rebranded image nobody has heard of still
    // trips it.
    const d = at('ID=somethingnew\nPRETTY_NAME="Something New"\n', ['/run/ostree-booted']);
    expect(d.immutable).toBe('ostree');
  });

  it('finds Bazzite by its own ID, and Silverblue by VARIANT_ID', () => {
    // Two different shapes: Universal Blue rewrites ID to the image name,
    // Fedora Atomic keeps ID=fedora and names the variant instead.
    expect(at(BAZZITE_RELEASE).immutable).toBe('ostree');
    expect(at(BAZZITE_RELEASE).variant).toBe('bazzite-nvidia');
    expect(at(SILVERBLUE_RELEASE).immutable).toBe('ostree');
    expect(at(SILVERBLUE_RELEASE).id).toBe('fedora');
  });

  it('finds SteamOS, and does not let it reach the Arch route', () => {
    // The regression this whole layer exists to stop. SteamOS IS Arch and says
    // so, so a route that reads `arch` first hands a Steam Deck a pacman
    // command that fails on a read-only root, or succeeds after the operator
    // disables that flag and is then erased by the next SteamOS update.
    const d = at(STEAMOS_RELEASE);
    expect(d.arch).toBe(true);
    expect(d.immutable).toBe('steamos');
    const hint = installHint('ollama', d, 'linux').join('\n');
    // The Arch package name never appears: the GPU-specific packages are the
    // wrong advice on an APU, and any pacman install here is erased anyway.
    expect(hint).not.toContain('ollama-cuda');
    expect(hint).not.toContain('ollama-rocm');
    // What it says instead is that the install does not survive, and what to
    // do about a machine that is a poor provider in the first place.
    expect(hint).toContain('steamos-readonly disable');
    expect(hint).toContain('erased');
    expect(hint).toContain('LLM_BASE_URL');
    // The container route is offered rather than dismissed, because a
    // container's storage lives in /home and does survive an update. What is
    // said plainly is that getting distrobox onto the Deck does not.
    expect(hint).toContain('distrobox create');
  });

  it('finds NixOS by its marker file as well as its ID', () => {
    expect(at(NIXOS_RELEASE).immutable).toBe('nixos');
    expect(at('ID=unknown\n', ['/etc/NIXOS']).immutable).toBe('nixos');
  });

  it('leaves an ordinary system alone', () => {
    expect(at(ARCH_RELEASE).immutable).toBe(null);
    expect(at(MINT_RELEASE).immutable).toBe(null);
    expect(at(CACHY_RELEASE).immutable).toBe(null);
  });
});

describe('immutableHint', () => {
  const d = (immutable: any): Distro => ({ ...UNKNOWN_DISTRO, immutable });

  it('carries the GPU flag into the container command, or the node serves from the CPU', () => {
    // An ollama in a container with no access to the card works, registers,
    // takes jobs, and is slow without ever saying why. The flag is the
    // difference and it belongs in the command the operator is shown.
    expect(immutableHint(d('ostree'), 'nvidia').join('\n')).toContain('--nvidia');
    expect(immutableHint(d('ostree'), 'none').join('\n')).not.toContain('--nvidia');
    // No --nvidia for AMD, and a line saying what to check instead.
    const amd = immutableHint(d('ostree'), 'amd').join('\n');
    expect(amd).not.toContain('--nvidia');
    expect(amd).toContain('/dev/kfd');
  });

  it('does not offer NixOS a command to run, because none applies', () => {
    // Packages come from a file the operator owns. No wizard edits it for them.
    const h = immutableHint(d('nixos')).join('\n');
    expect(h).toContain('services.ollama.enable = true;');
    expect(h).toContain('nixos-rebuild switch');
    expect(h).not.toContain('curl -fsSL');
  });

  it('names the reboot on MicroOS and the container that avoids it', () => {
    const h = immutableHint(d('microos')).join('\n');
    expect(h).toContain('transactional-update pkg install ollama');
    expect(h).toContain('distrobox create');
  });
});

describe('cloudflared on an immutable system', () => {
  it('needs no special route, because the node fetches its own binary', () => {
    // The tunnel half already works on these machines: a static binary in
    // bin/, run as the operator, no package manager and no reboot. Only the
    // engine was ever the problem.
    const steam: Distro = { ...UNKNOWN_DISTRO, id: 'steamos', like: ['arch'], arch: true, immutable: 'steamos' };
    expect(installHint('cloudflared', steam, 'linux')).not.toEqual(['sudo pacman -S --needed cloudflared']);
  });
});
