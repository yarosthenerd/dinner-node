/**
 * The tunnel binary, fetched rather than asked for.
 *
 * A node with no public URL serves its own LAN and earns nothing from the
 * network. `setup.ts` used to call that "a real mode, not a failure", print a
 * warning, and then print **ready**, which meant an operator could finish
 * onboarding, see green, and never earn a token without having been told
 * anything was wrong. The single dependency standing between those two states
 * is one static binary that needs no Cloudflare account, no token and no DNS.
 *
 * So this module gets it. Everything here is best effort and nothing throws:
 * an operator who declines, or whose download fails, still has a working
 * LAN-only node, and now hears that in those words.
 *
 * We do NOT vendor a pinned version. cloudflared is a network client talking to
 * Cloudflare's edge, and a copy pinned in this repo is a copy that goes stale
 * and starts failing handshakes with nobody watching. `latest` is the right
 * channel for it, and the verification below is what makes taking `latest`
 * defensible: the file is only installed once it has run and named itself.
 */
import { spawnSync, type spawnSync as SpawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hasCommand } from './platform.js';

const WIN = process.platform === 'win32';

/** Where a fetched binary lives. Gitignored: it is a build artifact, not source. */
export function binDir(moduleUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), '..', 'bin');
}
export function localPath(moduleUrl?: string): string {
  return join(binDir(moduleUrl), WIN ? 'cloudflared.exe' : 'cloudflared');
}

/**
 * The release asset for a platform and arch, or null where Cloudflare ships
 * none. Names verified against the live release listing.
 *
 * Windows on arm64 gets the amd64 build deliberately: there is no arm64
 * Windows asset, and those machines run x64 binaries under emulation. A
 * consumer Windows-on-ARM laptop has no discrete GPU anyway, so this path
 * matters for completeness rather than for supply.
 */
export function assetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === 'win32') return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
  if (platform === 'darwin') return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  if (platform === 'linux') {
    switch (arch) {
      case 'x64': return 'cloudflared-linux-amd64';
      case 'arm64': return 'cloudflared-linux-arm64';
      case 'arm': return 'cloudflared-linux-armhf';
      case 'ia32': return 'cloudflared-linux-386';
      default: return null;
    }
  }
  return null;
}

/**
 * Roughly how big the download is, so the confirm prompt can say. Measured off
 * the live release on 2026-09-03; these move slowly and only ever inform a
 * sentence, so a stale number costs nothing.
 */
export function approxMB(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return 55;
  if (platform === 'darwin') return 19;
  return 40;
}

export const releaseUrl = (asset: string) =>
  `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;

export type Resolved = { path: string; source: 'PATH' | 'downloaded' };

/**
 * Which cloudflared this node will run, if any.
 *
 * An operator's own install wins over ours: they may have configured it, and a
 * named tunnel run from a system install is the arrangement `PUBLIC_URL`
 * already means.
 */
export function resolveCloudflared(moduleUrl?: string): Resolved | null {
  if (hasCommand('cloudflared')) return { path: 'cloudflared', source: 'PATH' };
  const p = localPath(moduleUrl);
  return existsSync(p) ? { path: p, source: 'downloaded' } : null;
}

/**
 * Does this file run and call itself cloudflared.
 *
 * The check that makes an unpinned download safe to install. A truncated file,
 * an HTML error page saved with a binary's name, or the wrong architecture all
 * fail here rather than at 3am inside the announce loop.
 */
export function verify(path: string, spawn: typeof SpawnSync = spawnSync): boolean {
  try {
    const r = spawn(path, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    return r.status === 0 && /cloudflared/i.test(String(r.stdout ?? '') + String(r.stderr ?? ''));
  } catch { return false; }
}

export type DownloadResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; why: string };

export type DownloadOptions = {
  moduleUrl?: string;
  /** Told what is happening, so a 40 MB download is not a frozen terminal. */
  log?: (line: string) => void;
  fetchFn?: typeof fetch;
  spawnFn?: typeof SpawnSync;
  timeoutMs?: number;
  /** Force a specific release asset. Tests only, so the macOS tarball branch
   *  is reachable from a Linux runner. */
  asset?: string;
};

/**
 * Fetch cloudflared into `bin/`, verify it, and return where it landed.
 *
 * Downloaded to a `.part` and renamed only after `verify`, so a download killed
 * halfway cannot leave a broken binary that `resolveCloudflared` then trusts.
 */
export async function downloadCloudflared(opts: DownloadOptions = {}): Promise<DownloadResult> {
  const { moduleUrl, log = () => {}, fetchFn = fetch, spawnFn = spawnSync, timeoutMs = 180_000 } = opts;

  const asset = opts.asset ?? assetName();
  if (!asset) return { ok: false, why: `Cloudflare ships no cloudflared for ${process.platform}/${process.arch}` };

  const dir = binDir(moduleUrl);
  const dest = localPath(moduleUrl);
  const part = `${dest}.part`;
  const url = releaseUrl(asset);

  try {
    mkdirSync(dir, { recursive: true });
    log(`downloading ${asset}`);
    const res = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, why: `${url} returned ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    // A few hundred kilobytes would be a redirect page or an error, not a
    // 30-to-70 MB Go binary.
    if (buf.length < 1_000_000) return { ok: false, why: `downloaded only ${buf.length} bytes, which is not a binary` };

    if (asset.endsWith('.tgz')) {
      // macOS ships the binary inside a tarball holding exactly one file. tar
      // is present on every macOS install, so this needs nothing extra.
      const tgz = join(dir, 'cloudflared.tgz');
      writeFileSync(tgz, buf);
      const t = spawnFn('tar', ['-xzf', tgz, '-C', dir], { encoding: 'utf8', timeout: 60_000 });
      rmSync(tgz, { force: true });
      if (t.status !== 0) return { ok: false, why: `tar failed: ${String(t.stderr ?? '').trim() || t.status}` };
      // tar wrote `cloudflared` directly, which on darwin is already `dest`.
      if (!existsSync(dest)) return { ok: false, why: 'the archive did not contain cloudflared' };
    } else {
      writeFileSync(part, buf);
      renameSync(part, dest);
    }

    if (!WIN) { try { chmodSync(dest, 0o755); } catch { /* best effort */ } }

    if (!verify(dest, spawnFn)) {
      // Never leave a file behind that resolveCloudflared would pick up.
      rmSync(dest, { force: true });
      return { ok: false, why: 'the downloaded file did not run' };
    }
    return { ok: true, path: dest, bytes: buf.length };
  } catch (e: any) {
    rmSync(part, { force: true });
    return { ok: false, why: e?.name === 'TimeoutError' ? 'the download timed out' : (e?.message ?? String(e)) };
  }
}
