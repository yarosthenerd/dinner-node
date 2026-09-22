import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { startQuickTunnel, urlFromLine } from '../tunnel';

describe('reading the URL out of the banner', () => {
  it('finds it inside the box cloudflared draws', () => {
    // The real shape, pipes and all.
    expect(urlFromLine('|  https://litter-unfunded-improvise.trycloudflare.com                        |'))
      .toBe('https://litter-unfunded-improvise.trycloudflare.com');
  });

  it('finds it in a plain log line', () => {
    expect(urlFromLine('INF |  Your quick Tunnel has been created! Visit it at https://gray-fox-ate.trycloudflare.com'))
      .toBe('https://gray-fox-ate.trycloudflare.com');
  });

  it('ignores everything else cloudflared prints', () => {
    for (const l of [
      'INF Thank you for trying Cloudflare Tunnel.',
      'INF Requesting new quick Tunnel on trycloudflare.com...',
      'https://developers.cloudflare.com/cloudflare-tunnel/',
      '',
    ]) expect(urlFromLine(l), l).toBe(null);
  });
});

/** A stand-in for a spawned cloudflared, so no binary is needed to test this. */
function fakeCloudflared() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

describe('starting a quick tunnel', () => {
  it('resolves with the URL the process printed', async () => {
    const child = fakeCloudflared();
    const p = startQuickTunnel(4173, { spawnFn: (() => child) as any, log: () => {} });
    child.stderr.emit('data', Buffer.from('INF |  https://gray-fox-ate.trycloudflare.com  |\n'));
    const t = await p;
    expect(t?.url).toBe('https://gray-fox-ate.trycloudflare.com');
    t!.stop();
    expect(child.kill).toHaveBeenCalled();
  });

  it('resolves null when cloudflared is not installed', async () => {
    // A node with no public URL still serves its own LAN, so this is a mode
    // rather than a failure and must not throw into the startup path.
    const child = fakeCloudflared();
    const p = startQuickTunnel(4173, { spawnFn: (() => child) as any, log: () => {} });
    child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }));
    expect(await p).toBe(null);
  });

  it('resolves null when it exits before saying anything', async () => {
    const child = fakeCloudflared();
    const p = startQuickTunnel(4173, { spawnFn: (() => child) as any, log: () => {} });
    child.emit('exit', 1);
    expect(await p).toBe(null);
  });

  it('gives up rather than hanging the node forever', async () => {
    vi.useFakeTimers();
    const child = fakeCloudflared();
    const p = startQuickTunnel(4173, { spawnFn: (() => child) as any, log: () => {}, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5001);
    expect(await p).toBe(null);
    expect(child.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
