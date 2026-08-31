import { spawn, type ChildProcess } from 'node:child_process';

/**
 * A public URL for a node whose operator has not arranged one.
 *
 * The supply side of this project is consumer machines behind home routers.
 * They have no inbound reachability, no fixed address and no certificate, and
 * an operator who has to learn tunnels before their node earns anything is an
 * operator who stops. `setup.ts` has told people for a while that "a tunnel
 * will start with the node"; this is the code that makes that true.
 *
 * A quick tunnel is the right shape for a stranger's node specifically because
 * it is anonymous and disposable: no Cloudflare account, no DNS, a fresh
 * hostname every run, and the home IP never appears anywhere. Nodes we run
 * ourselves use named tunnels on our own subdomains instead, which is what
 * `PUBLIC_URL` being set already means.
 */

/** The hostname cloudflared prints once the tunnel is up. */
const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/**
 * cloudflared writes its banner to stderr, in a box drawn with plus signs and
 * pipes, and the URL can be surrounded by them. Extracted by pattern rather
 * than by column, because the box moves with the width of the hostname.
 */
export function urlFromLine(line: string): string | null {
  const m = URL_RE.exec(line);
  return m ? m[0] : null;
}

export type Tunnel = { url: string; stop(): void };

/**
 * Start a quick tunnel to `port` and resolve once cloudflared prints its URL.
 *
 * Resolves null rather than throwing when cloudflared is missing or silent.
 * A node with no public URL is not broken: it still serves its own LAN, which
 * `setup.ts` calls a real mode and not a failure.
 */
export function startQuickTunnel(port: number, opts: {
  timeoutMs?: number;
  log?: (s: string) => void;
  spawnFn?: typeof spawn;
} = {}): Promise<Tunnel | null> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const log = opts.log ?? console.log;
  const spawner = opts.spawnFn ?? spawn;

  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawner('cloudflared', [
        'tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      log(`[tunnel] cloudflared did not start: ${e?.message ?? e}`);
      return resolve(null);
    }

    let done = false;
    const finish = (t: Tunnel | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(t);
    };

    const timer = setTimeout(() => {
      log(`[tunnel] no URL after ${Math.round(timeoutMs / 1000)}s, carrying on without one`);
      try { child.kill(); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const onData = (buf: Buffer) => {
      for (const line of String(buf).split('\n')) {
        const url = urlFromLine(line);
        if (!url) continue;
        log(`[tunnel] ${url}`);
        finish({
          url,
          stop() { try { child.kill(); } catch { /* already gone */ } },
        });
        return;
      }
    };
    child.stderr?.on('data', onData);
    child.stdout?.on('data', onData);

    // ENOENT arrives here rather than as a throw, which is the usual case: no
    // cloudflared on the machine at all.
    child.on('error', (e: any) => {
      log(e?.code === 'ENOENT'
        ? '[tunnel] cloudflared is not installed, serving the LAN only'
        : `[tunnel] cloudflared failed: ${e?.message ?? e}`);
      finish(null);
    });
    child.on('exit', code => {
      // Only interesting before a URL appeared. After that, an exit is the
      // tunnel dying, which the re-announce loop will notice.
      if (!done) { log(`[tunnel] cloudflared exited with ${code} before printing a URL`); finish(null); }
    });

    // The tunnel must never be the reason this process stays alive, and it
    // must not outlive the node either: an orphaned cloudflared keeps a
    // hostname alive that points at a dead port.
    child.unref?.();
    const kill = () => { try { child.kill(); } catch { /* already gone */ } };
    process.once('exit', kill);
    process.once('SIGINT', () => { kill(); process.exit(130); });
    process.once('SIGTERM', () => { kill(); process.exit(143); });
  });
}
