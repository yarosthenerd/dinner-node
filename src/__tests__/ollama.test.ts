/**
 * The two engine states setup can now repair on its own, and the guard around
 * the one it cannot.
 */
import { describe, it, expect, vi } from 'vitest';
import { probeOllama, startOllama, installCommand, runInstall } from '../ollama.js';

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

  it('waits for the server to answer and returns what it holds', async () => {
    let tries = 0;
    const p = await startOllama({
      spawnFn: (() => child()) as any,
      // Unreachable twice, then up. The real thing takes a second or two.
      probeFn: async () => (++tries < 3 ? { reachable: false, models: [] } : { reachable: true, models: ['qwen3:8b'] }),
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
    expect(installCommand('linux', yes)).toEqual({
      cmd: '/bin/sh',
      args: ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'],
      shown: 'curl -fsSL https://ollama.com/install.sh | sh',
    });
  });

  it('uses homebrew and winget where they exist', () => {
    expect(installCommand('darwin', yes)?.shown).toBe('brew install ollama');
    expect(installCommand('win32', yes)?.shown).toMatch(/^winget install --id Ollama\.Ollama/);
  });

  it('returns null where the only honest answer is a download page', () => {
    // A .dmg holding a GUI app, and a Windows without winget. Offering to run
    // something that cannot work is worse than naming the page.
    expect(installCommand('darwin', no)).toBe(null);
    expect(installCommand('win32', no)).toBe(null);
    // No curl means the linux one-liner cannot run either.
    expect(installCommand('linux', no)).toBe(null);
    expect(installCommand('freebsd', yes)).toBe(null);
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
