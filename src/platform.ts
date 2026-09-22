/**
 * The handful of places where this node has to know which OS it is on.
 *
 * The supply side of this project is consumer machines with discrete GPUs, and
 * most of those run Windows. `hardware.ts` already probes all three platforms
 * properly. What did not was everything around it: the two helpers below were
 * written as POSIX one-liners, and both fail on win32 in ways that produce no
 * error at all.
 *
 * Linux is not one platform either, and the difference is not cosmetic. On an
 * Arch machine the vendor `install.sh` this file used to recommend writes
 * ollama into /usr/local behind the package manager's back, where it shadows
 * or is shadowed by a `pacman -S ollama` that carries the right GPU runtime
 * and a systemd unit. `detectDistro` exists so that route is taken only where
 * it is the ordinary one.
 *
 * Keep new platform branches here rather than inline, so there is one file to
 * read when a node behaves differently on someone else's machine.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const WIN = process.platform === 'win32';

/**
 * Is `cmd` on the PATH.
 *
 * The previous implementation was `spawnSync('command', ['-v', cmd], { shell: true })`.
 * On Windows `shell: true` means cmd.exe, where `command` is not a builtin and
 * not an executable, so the call returned a non-zero status for EVERY input.
 * `has('ollama')` and `has('cloudflared')` were therefore permanently false on
 * the platform holding most of the consumer GPUs: setup suppressed its offer to
 * pull a model, and told operators with cloudflared already installed that they
 * had no tunnel tool.
 *
 * Both branches are pure lookups with no side effects, which is why this does
 * not simply run `cmd --version`: some tools do work on that flag, and a probe
 * that starts a server or a daemon to find out whether it exists is not a probe.
 */
export function hasCommand(cmd: string, spawn: typeof spawnSync = spawnSync): boolean {
  const r = WIN
    ? spawn('where', [cmd], { stdio: 'ignore', windowsHide: true })
    // `command` is a shell builtin, so a shell has to run it. Passed as an
    // argument to sh rather than via `shell: true`, which concatenates without
    // escaping (node DEP0190) and would let a crafted name run anything.
    : spawn('/bin/sh', ['-c', 'command -v "$1"', 'sh', cmd], { stdio: 'ignore' });
  // ENOENT on the lookup tool itself: `where` missing from a stripped Windows,
  // or no shell. Nothing can be concluded, so claim nothing.
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return false;
  return r.status === 0;
}

/**
 * Absolute path to the repo's `.env`, given a module URL inside `src/`.
 *
 * `new URL('../.env', import.meta.url).pathname` returns `/C:/Users/x/.env` on
 * Windows: a POSIX path with a drive letter bolted into it. `existsSync` says
 * false, so setup read no config, generated a second wallet on every run, and
 * wrote it somewhere the node would not look. `fileURLToPath` is the API that
 * exists for this.
 */
export function repoEnvPath(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), '..', '.env');
}

/**
 * Which Linux this is, to the resolution the install routes below care about.
 *
 * Only two questions are asked of it. Is this Arch or an Arch derivative, so
 * that pacman is the ordinary route rather than a vendor script; and is
 * Omarchy on top of it, which changes nothing about what gets installed but
 * changes the command an operator recognises as belonging to their machine.
 *
 * `arch` is true for ID=arch and for anything naming arch in ID_LIKE, which is
 * how EndeavourOS, CachyOS and Manjaro identify themselves. Omarchy is a
 * configuration of Arch rather than its own distribution, so it reports
 * ID=arch and is detected separately: it exports OMARCHY_PATH into every
 * shell and puts $OMARCHY_PATH/bin on PATH.
 */
/**
 * A system where the ordinary package install does not apply, and why.
 *
 * These are not a footnote. A Bazzite or SteamOS machine is by definition a
 * discrete GPU that sits idle most of the day, which is the entire premise of
 * this project, and they are the machines where every install route this repo
 * knew was wrong.
 *
 * - `ostree`   Fedora Atomic and the Universal Blue images built on it:
 *              Silverblue, Kinoite, Bazzite, Bluefin, Aurora. /usr is read
 *              only and a package install needs a reboot.
 * - `steamos`  Read only until `steamos-readonly disable`, and everything
 *              written that way is wiped by the next SteamOS update.
 * - `nixos`    Nothing imperative applies at all. Packages come from
 *              configuration.nix, which is the operator's file to edit.
 * - `microos`  openSUSE MicroOS and Aeon: transactional-update, then reboot.
 */
export type Immutable = 'ostree' | 'steamos' | 'nixos' | 'microos';

export type Distro = {
  /** os-release ID, lowercased. Empty when there is no os-release to read. */
  id: string;
  /** os-release ID_LIKE, split on spaces. */
  like: string[];
  /** os-release VARIANT_ID, lowercased. Silverblue and Kinoite are here. */
  variant: string;
  /** PRETTY_NAME, for saying out loud what was detected. */
  pretty: string;
  /** Arch or an Arch derivative: pacman is present and is the right route. */
  arch: boolean;
  /** Omarchy's own tooling is available, so use the command it ships. */
  omarchy: boolean;
  /**
   * Set when the root filesystem is not an ordinary one to install into.
   *
   * Checked BEFORE `arch` everywhere a route is chosen. SteamOS reports
   * ID_LIKE=arch and is genuinely Arch underneath, so an install route that
   * reads `arch` first hands a Steam Deck `sudo pacman -S ollama-cuda`: it
   * fails on a read-only root, and if the operator gets past that by turning
   * the read-only flag off, the next SteamOS update deletes it again.
   */
  immutable: Immutable | null;
};

export const UNKNOWN_DISTRO: Distro = {
  id: '', like: [], variant: '', pretty: '', arch: false, omarchy: false, immutable: null,
};

/**
 * Read /etc/os-release. Every argument is injectable because the interesting
 * cases here are other people's machines, which is exactly the set this
 * machine cannot produce.
 */
export function detectDistro(
  opts: {
    platform?: NodeJS.Platform;
    readFile?: (p: string) => string;
    exists?: (p: string) => boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Distro {
  const {
    platform = process.platform,
    readFile = (p: string) => readFileSync(p, 'utf8'),
    exists = existsSync,
    env = process.env,
  } = opts;
  if (platform !== 'linux') return UNKNOWN_DISTRO;

  let raw = '';
  // /etc/os-release is the standard location and /usr/lib/os-release the
  // vendor fallback; a system with neither is answerable as "unknown", which
  // routes to the download link that works everywhere.
  for (const p of ['/etc/os-release', '/usr/lib/os-release']) {
    try { raw = readFile(p); break; } catch { /* next */ }
  }

  const kv = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    // Values are optionally quoted, and PRETTY_NAME almost always is.
    kv.set(t.slice(0, i), t.slice(i + 1).trim().replace(/^["']|["']$/g, ''));
  }

  const id = (kv.get('ID') ?? '').toLowerCase();
  const like = (kv.get('ID_LIKE') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const variant = (kv.get('VARIANT_ID') ?? '').toLowerCase();
  const arch = id === 'arch' || like.includes('arch');

  // Ordered by how much the answer can be trusted, not by how common the
  // system is. /run/ostree-booted is written by the initramfs of a booted
  // ostree deployment and is the one signal here that cannot be wrong; the
  // name checks below it are for systems that publish no such marker.
  //
  // Bazzite, Bluefin and Aurora set their own ID with ID_LIKE=fedora, and
  // Silverblue and Kinoite stay ID=fedora with VARIANT_ID naming the variant,
  // so both shapes are covered rather than one.
  const OSTREE_IDS = ['bazzite', 'bluefin', 'aurora', 'silverblue', 'kinoite'];
  const OSTREE_VARIANTS = ['silverblue', 'kinoite', 'sericea', 'onyx', 'iot'];
  const immutable: Immutable | null =
    exists('/etc/NIXOS') || id === 'nixos' ? 'nixos'
    : id === 'steamos' || exists('/usr/bin/steamos-readonly') ? 'steamos'
    : exists('/run/ostree-booted')
      || OSTREE_IDS.includes(id)
      || OSTREE_VARIANTS.includes(variant)
      || variant.startsWith('bazzite') ? 'ostree'
    : id.includes('microos') || variant.includes('microos') || variant.includes('aeon')
      || exists('/usr/sbin/transactional-update') ? 'microos'
    : null;

  // OMARCHY_PATH is exported by Omarchy's shell config and is what its own
  // scripts read. The directory is checked as well, for a non-login shell
  // where the export has not happened but the install still has.
  const omarchyPath = env.OMARCHY_PATH || (env.HOME ? join(env.HOME, '.local/share/omarchy') : '');
  const omarchy = Boolean(omarchyPath) && exists(omarchyPath);

  return { id, like, variant, pretty: kv.get('PRETTY_NAME') ?? '', arch, omarchy, immutable };
}

/**
 * Does this machine have a systemd unit by that name, installed or running.
 *
 * The question matters for exactly one decision: whether to start ollama by
 * spawning `ollama serve` or by asking systemd. Arch's package ships
 * ollama.service, and on a machine where it is present the spawned server
 * either loses the race to bind :11434 or wins it and leaves an unmanaged
 * process that the operator's `systemctl status ollama` will not show.
 *
 * `systemctl list-unit-files` rather than `status`: status exits non-zero for
 * a unit that exists and is merely stopped, which is precisely the state this
 * has to be able to see.
 */
export function hasSystemdUnit(unit: string, spawn: typeof spawnSync = spawnSync): boolean {
  if (process.platform !== 'linux') return false;
  const r = spawn('systemctl', ['list-unit-files', '--no-legend', unit], { encoding: 'utf8', timeout: 4000 });
  if (r.error || r.status !== 0) return false;
  // An unknown unit is not an error: systemctl exits 0 having listed nothing.
  return Boolean((r.stdout ?? '').trim());
}

/**
 * How to install a thing, phrased for the machine the operator is actually on.
 * Package managers are named only where they are the ordinary route; a download
 * link is the fallback everywhere because it always works.
 */
export function installHint(
  tool: 'ollama' | 'cloudflared' | 'lmstudio',
  distro: Distro = detectDistro(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const win = platform === 'win32';
  const mac = platform === 'darwin';

  if (tool === 'lmstudio') {
    // No package-manager route is named here on purpose. LM Studio ships as a
    // desktop app with its own updater on all three platforms, and the
    // third-party packages that exist are not ones this file can promise are
    // current. The headless server is a flag on that same app.
    return [
      'download it: https://lmstudio.ai/download',
      'then either start the app, or run: lms server start',
    ];
  }

  if (tool === 'ollama') {
    if (win) return ['winget install Ollama.Ollama', 'or download it: https://ollama.com/download/windows'];
    if (mac) return ['brew install ollama', 'or download it: https://ollama.com/download/mac'];
    // Before the Arch branch, deliberately. SteamOS is Arch underneath and
    // says so in ID_LIKE, and pacman is still the wrong answer there.
    if (distro.immutable) return immutableHint(distro);
    if (distro.arch) {
      // Named by GPU because the three packages are not interchangeable: the
      // plain one is CPU inference, and installing it on a machine with a card
      // is the silent half-speed failure this whole setup exists to prevent.
      const pkg = distro.omarchy ? 'omarchy-pkg-add' : 'sudo pacman -S --needed';
      return [
        `${pkg} ollama-cuda   # NVIDIA`,
        `${pkg} ollama-rocm   # AMD`,
        `${pkg} ollama        # CPU only`,
        'then: sudo systemctl enable --now ollama',
      ];
    }
    return ['curl -fsSL https://ollama.com/install.sh | sh'];
  }

  if (win) return ['winget install Cloudflare.cloudflared', 'or download cloudflared-windows-amd64.exe from', '  https://github.com/cloudflare/cloudflared/releases/latest'];
  if (mac) return ['brew install cloudflared'];
  // Nothing special for an immutable system here, and that is the point: this
  // node downloads a static cloudflared into bin/ and runs it as the operator,
  // which needs no package manager, no root and no reboot. The tunnel half of
  // the setup already works on these machines. Only the engine does not.
  if (distro.arch && !distro.immutable) {
    return [distro.omarchy ? 'omarchy-pkg-add cloudflared' : 'sudo pacman -S --needed cloudflared'];
  }
  return ['https://developers.cloudflare.com/cloudflare-tunnel/downloads/'];
}

/**
 * How an operator starts ollama by hand, when it is installed but not serving.
 *
 * A function rather than the constant it used to be, because the right answer
 * on Arch is the systemd unit its package ships, and telling an operator to
 * run `ollama serve` in a terminal on a machine that has one produces a server
 * their own service manager does not know about.
 */
export function ollamaServeHint(
  platform: NodeJS.Platform = process.platform,
  hasUnit: (u: string) => boolean = hasSystemdUnit,
): string {
  if (platform === 'win32') return 'it is installed but not running: start the Ollama app from the Start menu';
  if (hasUnit('ollama.service')) return 'it is installed but not running: sudo systemctl enable --now ollama';
  return 'it is installed but not running: ollama serve';
}

/**
 * What to do about an engine on a system whose root cannot be installed into.
 *
 * Every line here is the route that system's own documentation gives, and
 * where that route is a container, the GPU flag is part of it. An ollama in a
 * container with no access to the card runs on the CPU and says nothing about
 * it, which is the same silent half-speed failure that `ollamaPackage` exists
 * to prevent one layer up.
 */
export function immutableHint(distro: Distro, gpuVendor: 'nvidia' | 'amd' | 'none' = 'none'): string[] {
  const nvidia = gpuVendor === 'nvidia' ? ' --nvidia' : '';
  const box = [
    `distrobox create --name dinnernode --image fedora:latest${nvidia} --yes`,
    "distrobox enter dinnernode -- sh -c 'curl -fsSL https://ollama.com/install.sh | sh'",
  ];

  if (distro.immutable === 'nixos') {
    // The one system here where nothing imperative applies. Packages come from
    // a file the operator owns, and no wizard should be editing it for them.
    return [
      'add to your configuration.nix:',
      '  services.ollama.enable = true;',
      '  services.ollama.acceleration = "cuda";   # or "rocm", or omit for CPU',
      'then: sudo nixos-rebuild switch',
    ];
  }

  if (distro.immutable === 'steamos') {
    // The honest branch, and the least satisfying one. Every route into a
    // Steam Deck's root is erased by the next SteamOS update, including the
    // one that would install the container tooling, so there is nothing to
    // recommend that stays installed. Saying that plainly beats handing over a
    // command that works once and then quietly stops being there.
    return [
      'SteamOS keeps / read only, and everything written past that is erased',
      'by the next SteamOS update, so this has to be redone after each one:',
      '  sudo steamos-readonly disable',
      '  sudo pacman-key --init && sudo pacman-key --populate archlinux holo',
      '  sudo pacman -S ollama',
      'A container survives updates once it exists, because its storage lives',
      'in your home directory. Getting there is the problem: neither distrobox',
      'nor podman is preinstalled, and installing them has the same fate as',
      'the above. If you already have distrobox, use it:',
      ...box,
      '',
      'A Deck is also a weak provider: its GPU is an APU sharing system RAM.',
      'If you have a stronger machine, point this node at it instead and leave',
      'the Deck out of it: set LLM_BASE_URL to that machine\'s engine.',
    ];
  }

  if (distro.immutable === 'microos') {
    return [
      'transactional-update pkg install ollama   # then reboot',
      'or, without a reboot, in a container:',
      ...box,
    ];
  }

  // ostree: Silverblue, Kinoite, Bazzite, Bluefin, Aurora. distrobox is
  // preinstalled on the Universal Blue images, which is most of the machines
  // that reach this line.
  return [
    '/usr is read only here, so the vendor installer cannot write to it.',
    'A container is the route this system documents, and it keeps the GPU:',
    ...box,
    ...(gpuVendor === 'amd'
      ? ['(AMD: check /dev/kfd and /dev/dri reach the container before trusting the speed)']
      : []),
  ];
}
