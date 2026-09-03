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
import { hasCommand } from './platform.js';

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
  } = opts;

  if (!hasCommand('ollama')) return { reachable: false, models: [] };

  try {
    const child = spawnFn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
    log('started ollama in the background');
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
 * How to install ollama on this machine, when there is a route that can be run
 * unattended-but-confirmed. Null where the only honest answer is a download
 * page, which is macOS without homebrew (a .dmg holding a GUI app) and Windows
 * without winget.
 *
 * The Linux route pipes a vendor script into a shell, which is what Ollama
 * publishes and what its own documentation tells people to run. It is shown in
 * full and confirmed before it runs, never assumed from --yes, because a
 * script that escalates to root is not something to start on someone's behalf.
 */
export function installCommand(
  platform: NodeJS.Platform = process.platform,
  hasCmd: (c: string) => boolean = hasCommand,
): InstallCommand | null {
  if (platform === 'linux') {
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
