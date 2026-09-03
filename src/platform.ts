/**
 * The handful of places where this node has to know which OS it is on.
 *
 * The supply side of this project is consumer machines with discrete GPUs, and
 * most of those run Windows. `hardware.ts` already probes all three platforms
 * properly. What did not was everything around it: the two helpers below were
 * written as POSIX one-liners, and both fail on win32 in ways that produce no
 * error at all.
 *
 * Keep new platform branches here rather than inline, so there is one file to
 * read when a node behaves differently on someone else's machine.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
 * How to install a thing, phrased for the machine the operator is actually on.
 * Package managers are named only where they are the ordinary route; a download
 * link is the fallback everywhere because it always works.
 */
export function installHint(tool: 'ollama' | 'cloudflared'): string[] {
  if (tool === 'ollama') {
    if (WIN) return ['winget install Ollama.Ollama', 'or download it: https://ollama.com/download/windows'];
    if (process.platform === 'darwin') return ['brew install ollama', 'or download it: https://ollama.com/download/mac'];
    return ['curl -fsSL https://ollama.com/install.sh | sh'];
  }
  if (WIN) return ['winget install Cloudflare.cloudflared', 'or download cloudflared-windows-amd64.exe from', '  https://github.com/cloudflare/cloudflared/releases/latest'];
  if (process.platform === 'darwin') return ['brew install cloudflared'];
  return ['https://developers.cloudflare.com/cloudflare-tunnel/downloads/'];
}

/** How an operator starts ollama by hand, when it is installed but not serving. */
export const OLLAMA_SERVE_HINT = WIN
  ? 'it is installed but not running: start the Ollama app from the Start menu'
  : 'it is installed but not running: ollama serve';
