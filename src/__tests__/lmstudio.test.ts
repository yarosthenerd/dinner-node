/**
 * The LM Studio probe, against the two response shapes it can meet.
 *
 * The distinction the tests are built around is `detailed`. LM Studio's own
 * REST endpoint reports the context length the model is loaded at; the
 * OpenAI-shaped one does not. Setup uses that number to decide whether this
 * node is advertising more context than the engine will honour, and a guessed
 * value there is the same defect as the missing num_ctx was on ollama: a
 * prompt accepted by the node and silently truncated by the engine.
 */
import { describe, it, expect, vi } from 'vitest';
import { probeLmStudio, defaultModel, servable, openaiBase, startLmStudio, type LmModel } from '../lmstudio.js';

const jsonRes = (body: any, ok = true) => ({ ok, json: async () => body });

/** A fetch stand-in that answers one path and 404s everything else. */
function serving(path: string, body: any) {
  return (async (url: string) => (String(url).endsWith(path) ? jsonRes(body) : jsonRes({}, false))) as any;
}

const V0 = {
  data: [
    { id: 'qwen3-8b', object: 'model', type: 'llm', state: 'loaded', max_context_length: 40960, loaded_context_length: 8192 },
    { id: 'qwen3-14b', object: 'model', type: 'llm', state: 'not-loaded', max_context_length: 40960 },
    { id: 'nomic-embed-text-v1.5', object: 'model', type: 'embeddings', state: 'not-loaded', max_context_length: 2048 },
  ],
};

describe('probeLmStudio', () => {
  it('prefers the native endpoint, which carries the numbers that decide things', async () => {
    const p = await probeLmStudio('http://x', 100, serving('/api/v0/models', V0));
    expect(p.reachable).toBe(true);
    expect(p.detailed).toBe(true);
    expect(p.models[0]).toEqual({
      id: 'qwen3-8b', loaded: true, maxCtx: 40960, loadedCtx: 8192, type: 'llm',
    });
    expect(p.models[1].loaded).toBe(false);
  });

  it('falls back to /v1/models, and says the context is unknown rather than guessing', async () => {
    // An older build. Reporting maxCtx 0 is what makes setup print "this build
    // does not report context length" instead of a number it cannot support.
    const p = await probeLmStudio('http://x', 100, serving('/v1/models', {
      data: [{ id: 'qwen3-8b', object: 'model' }],
    }));
    expect(p.reachable).toBe(true);
    expect(p.detailed).toBe(false);
    expect(p.models).toEqual([{ id: 'qwen3-8b', loaded: false, maxCtx: 0, loadedCtx: 0, type: 'llm' }]);
  });

  it('never throws into the startup path', async () => {
    const refused = await probeLmStudio('http://x', 100, (async () => { throw new Error('ECONNREFUSED'); }) as any);
    expect(refused).toEqual({ reachable: false, models: [], detailed: false });

    const broken = await probeLmStudio('http://x', 100, (async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })) as any);
    expect(broken.reachable).toBe(false);

    const empty = await probeLmStudio('http://x', 100, serving('/v1/models', {}));
    expect(empty).toMatchObject({ reachable: true, models: [] });
  });

  it('tolerates a trailing slash, because an operator-typed URL has one', async () => {
    const seen: string[] = [];
    await probeLmStudio('http://x/', 100, (async (u: string) => { seen.push(u); return jsonRes(V0); }) as any);
    expect(seen[0]).toBe('http://x/api/v0/models');
  });
});

describe('openaiBase', () => {
  it('is what LLM_BASE_URL has to hold, with no doubled slash', () => {
    expect(openaiBase('http://localhost:1234')).toBe('http://localhost:1234/v1');
    expect(openaiBase('http://localhost:1234/')).toBe('http://localhost:1234/v1');
  });
});

describe('servable and defaultModel', () => {
  const models = (): LmModel[] => [
    { id: 'embed', loaded: true, maxCtx: 2048, loadedCtx: 2048, type: 'embeddings' },
    { id: 'small', loaded: false, maxCtx: 4096, loadedCtx: 0, type: 'llm' },
    { id: 'big', loaded: false, maxCtx: 40960, loadedCtx: 0, type: 'llm' },
    { id: 'resident', loaded: true, maxCtx: 8192, loadedCtx: 8192, type: 'llm' },
  ];

  it('will not offer an embedding model as something to chat with', () => {
    // It is in the list LM Studio returns and it cannot answer a prompt.
    expect(servable(models()).map(m => m.id)).toEqual(['small', 'big', 'resident']);
  });

  it('prefers the model already resident over a larger one that is not', () => {
    // The one the operator was last using, and the only one that costs nothing
    // to start. `big` has five times the context and still loses.
    expect(defaultModel(models())).toBe('resident');
  });

  it('falls back to the largest context when nothing is loaded', () => {
    expect(defaultModel(models().map(m => ({ ...m, loaded: false })))).toBe('big');
  });

  it('is null when there is nothing to serve', () => {
    expect(defaultModel([])).toBe(null);
    expect(defaultModel([{ id: 'e', loaded: true, maxCtx: 512, loadedCtx: 512, type: 'embeddings' }])).toBe(null);
  });
});

describe('startLmStudio', () => {
  it('starts the headless server on the port the node will talk to', async () => {
    const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
    const p = await startLmStudio({
      url: 'http://localhost:4321',
      spawnFn: ((cmd: string, args: string[], opts: any) => {
        calls.push({ cmd, args, opts });
        return { unref: vi.fn() } as any;
      }) as any,
      probeFn: async () => ({ reachable: true, models: [], detailed: true }),
      sleep: async () => {},
      hasCmd: () => true,
    });
    // Asserted unconditionally. This was wrapped in `if (calls.length)` because
    // hasCommand('lms') gated the spawn and the CLI is installed on almost no
    // machine, this one included, so the body never ran and the test passed by
    // asserting nothing at all. Injecting the check is what makes the branch
    // reachable.
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('lms');
    expect(calls[0].args).toEqual(['server', 'start', '--port', '4321']);
    // Detached: the server has to outlive setup, because the node started
    // immediately afterwards is what needs it.
    expect(calls[0].opts).toMatchObject({ detached: true });
    expect(p.reachable).toBe(true);
  });

  it('gives up rather than hanging when it never comes up', async () => {
    const p = await startLmStudio({
      spawnFn: (() => ({ unref: vi.fn() })) as any,
      probeFn: async () => ({ reachable: false, models: [], detailed: false }),
      timeoutMs: 40,
      intervalMs: 10,
    });
    expect(p.reachable).toBe(false);
  });
});
