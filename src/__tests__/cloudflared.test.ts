/**
 * The fetch-it-yourself path for the tunnel binary.
 *
 * The download itself is not exercised against the network here: what is
 * tested is every way it can go wrong and still leave the node in a state
 * `resolveCloudflared` will not lie about, because that is the failure this
 * module exists to prevent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetName, releaseUrl, approxMB, verify, downloadCloudflared, localPath } from '../cloudflared.js';

describe('release assets', () => {
  it('names the asset Cloudflare actually publishes', () => {
    // Checked against the live release listing on 2026-09-03. A rename here is
    // a 404 at the moment an operator is being onboarded, so it is pinned.
    expect(assetName('linux', 'x64')).toBe('cloudflared-linux-amd64');
    expect(assetName('linux', 'arm64')).toBe('cloudflared-linux-arm64');
    expect(assetName('linux', 'arm')).toBe('cloudflared-linux-armhf');
    expect(assetName('darwin', 'arm64')).toBe('cloudflared-darwin-arm64.tgz');
    expect(assetName('darwin', 'x64')).toBe('cloudflared-darwin-amd64.tgz');
    expect(assetName('win32', 'x64')).toBe('cloudflared-windows-amd64.exe');
    expect(assetName('win32', 'ia32')).toBe('cloudflared-windows-386.exe');
  });

  it('gives Windows on ARM the amd64 build', () => {
    // There is no arm64 Windows asset; those machines emulate x64.
    expect(assetName('win32', 'arm64')).toBe('cloudflared-windows-amd64.exe');
  });

  it('returns null where Cloudflare ships nothing, rather than a broken URL', () => {
    expect(assetName('freebsd', 'x64')).toBe(null);
    expect(assetName('linux', 'mips')).toBe(null);
  });

  it('builds a latest-release URL', () => {
    expect(releaseUrl('cloudflared-linux-amd64'))
      .toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64');
  });

  it('has a size to put in the prompt for every platform', () => {
    for (const p of ['linux', 'darwin', 'win32'] as NodeJS.Platform[]) expect(approxMB(p)).toBeGreaterThan(0);
  });
});

describe('verify', () => {
  const spawnOk = (() => ({ status: 0, stdout: 'cloudflared version 2026.8.1', stderr: '' })) as any;
  const spawnWrongBinary = (() => ({ status: 0, stdout: 'GNU bash, version 5.2', stderr: '' })) as any;
  const spawnFails = (() => ({ status: 126, stdout: '', stderr: 'cannot execute binary file' })) as any;

  it('accepts a binary that runs and names itself', () => {
    expect(verify('/x/cloudflared', spawnOk)).toBe(true);
  });

  it('rejects something else that happens to run', () => {
    expect(verify('/x/cloudflared', spawnWrongBinary)).toBe(false);
  });

  it('rejects a file that will not execute', () => {
    // The wrong architecture, which downloads perfectly and then never runs.
    expect(verify('/x/cloudflared', spawnFails)).toBe(false);
  });

  it('returns false rather than throwing when spawn itself blows up', () => {
    expect(verify('/x/cloudflared', (() => { throw new Error('EACCES'); }) as any)).toBe(false);
  });
});

describe('downloadCloudflared', () => {
  let dir: string;
  /** A module URL whose parent has a bin/ we can throw away. */
  let moduleUrl: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dn-cf-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    moduleUrl = pathToFileURL(join(dir, 'src', 'cloudflared.ts')).href;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const big = (n = 2_000_000) => Buffer.alloc(n, 7);
  const res = (body: Buffer, ok = true, status = 200) => ({
    ok, status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }) as any;

  it('installs a binary that verifies', async () => {
    const r = await downloadCloudflared({
      moduleUrl,
      fetchFn: (async () => res(big())) as any,
      spawnFn: (() => ({ status: 0, stdout: 'cloudflared version 2026.8.1', stderr: '' })) as any,
    });
    expect(r.ok).toBe(true);
    expect(existsSync(localPath(moduleUrl))).toBe(true);
  });

  it('leaves nothing behind when the file does not verify', async () => {
    // The case that matters: a file left in bin/ is one resolveCloudflared
    // would hand to the tunnel, which then fails at boot instead of here.
    const r = await downloadCloudflared({
      moduleUrl,
      fetchFn: (async () => res(big())) as any,
      spawnFn: (() => ({ status: 1, stdout: '', stderr: 'not an executable' })) as any,
    });
    expect(r.ok).toBe(false);
    expect(existsSync(localPath(moduleUrl))).toBe(false);
  });

  it('refuses a body too small to be a binary', async () => {
    // An HTML error page or a redirect stub saved under a binary's name.
    const r = await downloadCloudflared({
      moduleUrl,
      fetchFn: (async () => res(Buffer.from('<html>404</html>'))) as any,
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).why).toMatch(/not a binary/);
    expect(existsSync(localPath(moduleUrl))).toBe(false);
  });

  it('reports a non-200 rather than writing it', async () => {
    const r = await downloadCloudflared({ moduleUrl, fetchFn: (async () => res(big(), false, 503)) as any });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).why).toMatch(/503/);
  });

  it('reports a network failure without throwing into setup', async () => {
    const r = await downloadCloudflared({
      moduleUrl,
      fetchFn: (async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); }) as any,
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).why).toMatch(/ENOTFOUND/);
  });

  it('reports a failed extraction on the macOS tarball path', async () => {
    // macOS is the one platform where the asset is an archive. Reachable from
    // any runner through the asset override, because the branch that only ever
    // runs on someone else's machine is the branch that breaks unseen.
    const r = await downloadCloudflared({
      moduleUrl,
      asset: 'cloudflared-darwin-arm64.tgz',
      fetchFn: (async () => res(big())) as any,
      spawnFn: (() => ({ status: 1, stdout: '', stderr: 'tar: not in gzip format' })) as any,
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).why).toMatch(/gzip/);
    expect(existsSync(localPath(moduleUrl))).toBe(false);
    // The tarball is removed whether or not tar succeeded.
    expect(existsSync(join(dir, 'bin', 'cloudflared.tgz'))).toBe(false);
  });

  it('refuses an archive that did not contain cloudflared', async () => {
    const r = await downloadCloudflared({
      moduleUrl,
      asset: 'cloudflared-darwin-arm64.tgz',
      fetchFn: (async () => res(big())) as any,
      // tar "succeeds" and writes nothing we recognise.
      spawnFn: (() => ({ status: 0, stdout: '', stderr: '' })) as any,
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).why).toMatch(/did not contain/);
  });

  it('never leaves a .part behind', async () => {
    await downloadCloudflared({
      moduleUrl,
      fetchFn: (async () => res(big())) as any,
      spawnFn: (() => ({ status: 1, stdout: '', stderr: '' })) as any,
    });
    expect(existsSync(`${localPath(moduleUrl)}.part`)).toBe(false);
  });
});
