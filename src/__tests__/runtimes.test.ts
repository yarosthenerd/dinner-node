/**
 * Discovery, against the response shapes the real runtimes return.
 *
 * The fixtures are verbatim shapes, not minimal ones: KoboldCpp's capability
 * object as koboldcpp.py builds it, llama-server's /props as it is documented.
 * The point of every test here is the same one, from a different side: a port
 * is not evidence. Four of these runtimes default to :8080 and so does half
 * the software on a developer's laptop, so the tests are written around what
 * happens when the wrong thing is listening.
 */
import { describe, it, expect } from 'vitest';
import { discover, probeSpec, describe as describeFound, openaiModels, extraSpecs, KNOWN } from '../runtimes.js';

const ok = (body: any) => ({ ok: true, json: async () => body });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}) });

/**
 * A fetch stand-in over a routing table of exact URLs. Anything not in the
 * table 404s, which is what a real server does for another runtime's endpoint.
 */
function server(routes: Record<string, any>) {
  const seen: string[] = [];
  const fn = (async (url: string) => {
    seen.push(String(url));
    const hit = routes[String(url)];
    return hit === undefined ? notFound() : ok(hit);
  }) as any;
  return { fn, seen };
}

const MODELS = (...ids: string[]) => ({ data: ids.map(id => ({ id, object: 'model' })) });

const spec = (id: string) => KNOWN.find(s => s.id === id)!;

describe('openaiModels', () => {
  it('accepts a model list and rejects everything else on the port', async () => {
    const s = server({ 'http://localhost:8080/v1/models': MODELS('a') });
    expect(await openaiModels('http://localhost:8080/v1', s.fn, 100)).toEqual(['a']);

    // The things actually found on :8080. None of them may be taken for an
    // engine: a node that points at one takes payment and cannot deliver.
    for (const body of [{ hello: 'world' }, { data: 'not an array' }, { data: [] }, { data: [{ name: 'no id' }] }]) {
      const bad = server({ 'http://localhost:8080/v1/models': body });
      expect(await openaiModels('http://localhost:8080/v1', bad.fn, 100)).toBe(null);
    }
  });

  it('is null rather than throwing when the port is closed or answers junk', async () => {
    const refused = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    expect(await openaiModels('http://localhost:8080/v1', refused, 100)).toBe(null);

    const html = (async () => ({ ok: true, json: async () => { throw new Error('not json'); } })) as any;
    expect(await openaiModels('http://localhost:8080/v1', html, 100)).toBe(null);
  });
});

describe('KoboldCpp', () => {
  // As koboldcpp.py's get_capabilities() builds it.
  const CAPS = {
    result: 'KoboldCpp', version: '1.99.4', protected: false, llm: true,
    txt2img: false, vision: false, audio: false, transcribe: false,
  };

  it('is identified by its own endpoint, and reports the context it serves', async () => {
    const s = server({
      'http://localhost:5001/v1/models': MODELS('koboldcpp/qwen3-8b-q4_k_m'),
      'http://localhost:5001/api/extra/version': CAPS,
      'http://localhost:5001/api/extra/true_max_context_length': { value: 16384 },
    });
    const f = await probeSpec(spec('koboldcpp'), 'localhost', 100, s.fn);
    expect(f).not.toBe(null);
    expect(f!.identified).toBe(true);
    expect(f!.ctx).toBe(16384);
    expect(f!.detail).toBe('v1.99.4');
    expect(f!.base).toBe('http://localhost:5001/v1');
    // The server-wide context is written onto the model row, so setup can ask
    // one question about context whichever runtime answered.
    expect(f!.models).toEqual([
      { id: 'koboldcpp/qwen3-8b-q4_k_m', loaded: false, maxCtx: 16384, loadedCtx: 16384, type: 'llm' },
    ]);
  });

  it('carries the password flag, because a protected instance refuses this node', async () => {
    // Worth knowing at setup rather than when a guest has already paid.
    const s = server({
      'http://localhost:5001/v1/models': MODELS('m'),
      'http://localhost:5001/api/extra/version': { ...CAPS, protected: true },
      'http://localhost:5001/api/extra/true_max_context_length': { value: 8192 },
    });
    const f = await probeSpec(spec('koboldcpp'), 'localhost', 100, s.fn);
    expect(f!.needsPassword).toBe(true);
  });

  it('is not claimed when something else is on 5001', async () => {
    // A model list and no KoboldCpp behind it. Found, usable, unnamed.
    const s = server({ 'http://localhost:5001/v1/models': MODELS('m') });
    const f = await probeSpec(spec('koboldcpp'), 'localhost', 100, s.fn);
    expect(f!.identified).toBe(false);
    expect(describeFound(f!)).toContain('nothing confirmed it');
    expect(describeFound(f!)).not.toMatch(/^KoboldCpp/);
  });
});

describe('llama.cpp', () => {
  const PROPS = {
    model_alias: 'qwen3-8b',
    build_info: 'b4321',
    total_slots: 1,
    default_generation_settings: { n_ctx: 8192, n_predict: -1 },
  };

  it('is identified by /props, which also says the context it loaded', async () => {
    const s = server({
      'http://localhost:8080/v1/models': MODELS('qwen3-8b-q4_k_m.gguf'),
      'http://localhost:8080/props': PROPS,
    });
    const f = await probeSpec(spec('llamacpp'), 'localhost', 100, s.fn);
    expect(f!.identified).toBe(true);
    expect(f!.ctx).toBe(8192);
    expect(describeFound(f!)).toBe('llama.cpp (llama-server) b4321 on http://localhost:8080');
  });

  it('survives a build that reports only one of the two /props keys', async () => {
    const s = server({
      'http://localhost:8080/v1/models': MODELS('m'),
      'http://localhost:8080/props': { build_info: 'b9999' },
    });
    const f = await probeSpec(spec('llamacpp'), 'localhost', 100, s.fn);
    expect(f!.identified).toBe(true);
    // Nothing said what the context is, and 0 is how that is reported.
    expect(f!.ctx).toBe(0);
  });

  it('refuses to name a development server that happens to hold :8080', async () => {
    // The case this whole design exists for. Something answers /v1/models on
    // the port llama.cpp, LocalAI, llamafile and Ramalama all default to.
    const s = server({ 'http://localhost:8080/v1/models': MODELS('gpt-4o') });
    const f = await probeSpec(spec('llamacpp'), 'localhost', 100, s.fn);
    expect(f!.identified).toBe(false);
    expect(f!.spec.id).toBe('llamacpp');
    expect(describeFound(f!)).toContain('an OpenAI-compatible server on http://localhost:8080');
  });
});

describe('LM Studio', () => {
  const V0 = {
    data: [
      { id: 'qwen/qwen3-8b', type: 'llm', state: 'loaded', max_context_length: 40960, loaded_context_length: 8192 },
      { id: 'nomic-embed', type: 'embeddings', state: 'not-loaded', max_context_length: 2048 },
    ],
  };

  it('keeps its per-model detail rather than the flattened list', async () => {
    const s = server({
      'http://localhost:1234/v1/models': MODELS('qwen/qwen3-8b', 'nomic-embed'),
      'http://localhost:1234/api/v0/models': V0,
    });
    const f = await probeSpec(spec('lmstudio'), 'localhost', 100, s.fn);
    expect(f!.identified).toBe(true);
    // The embedding row is preserved here and filtered by `servable` at the
    // point of choosing, so nothing silently drops out of the operator's view.
    expect(f!.models).toHaveLength(2);
    expect(f!.models[0]).toMatchObject({ id: 'qwen/qwen3-8b', loaded: true, loadedCtx: 8192 });
    // Context comes from the loaded model, ignoring the embedding one.
    expect(f!.ctx).toBe(8192);
  });

  it('is still usable when only the OpenAI-shaped endpoint answers', async () => {
    // An older build. Found and served, with the context reported as unknown
    // rather than as a number nobody measured.
    const s = server({ 'http://localhost:1234/v1/models': MODELS('qwen/qwen3-8b') });
    const f = await probeSpec(spec('lmstudio'), 'localhost', 100, s.fn);
    expect(f!.identified).toBe(false);
    expect(f!.ctx).toBe(0);
    expect(f!.models.map(m => m.id)).toEqual(['qwen/qwen3-8b']);
  });
});

describe('runtimes with no fingerprint', () => {
  it('are found and reported as unconfirmed, never named on port alone', async () => {
    // Jan, GPT4All and text-generation-webui publish nothing that
    // distinguishes them. Being found is worth a great deal; being named
    // wrongly would send a paying node's traffic somewhere nobody chose.
    for (const id of ['jan', 'gpt4all', 'textgen', 'vllm']) {
      const sp = spec(id);
      expect(sp.fingerprint).toBeUndefined();
      const s = server({ [`http://localhost:${sp.port}/v1/models`]: MODELS('m') });
      const f = await probeSpec(sp, 'localhost', 100, s.fn);
      expect(f!.identified).toBe(false);
      expect(describeFound(f!)).toContain(`${sp.name}'s default port`);
    }
  });
});

describe('discover', () => {
  it('returns every engine answering, and nothing for the closed ports', async () => {
    const s = server({
      'http://localhost:1234/v1/models': MODELS('qwen/qwen3-8b'),
      'http://localhost:1234/api/v0/models': { data: [{ id: 'qwen/qwen3-8b', type: 'llm', state: 'loaded', max_context_length: 40960, loaded_context_length: 32768 }] },
      'http://localhost:5001/v1/models': MODELS('kobold-model'),
      'http://localhost:5001/api/extra/version': { result: 'KoboldCpp', version: '1.99.4', protected: false },
      'http://localhost:5001/api/extra/true_max_context_length': { value: 4096 },
    });
    const found = await discover({ timeoutMs: 100, fetchFn: s.fn });
    expect(found.map(f => f.spec.id).sort()).toEqual(['koboldcpp', 'lmstudio']);
    expect(found.every(f => f.identified)).toBe(true);
  });

  it('finds nothing on a machine running no engine, and does not throw doing it', async () => {
    const refused = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    expect(await discover({ timeoutMs: 100, fetchFn: refused })).toEqual([]);
  });

  it('probes the ports in parallel, so a filtered firewall costs one timeout', async () => {
    // In series with seven closed ports this would be seven timeouts on the
    // front of every setup run, which is the whole wizard feeling broken.
    let open = 0;
    let peak = 0;
    const slow = (async () => {
      peak = Math.max(peak, ++open);
      await new Promise(r => setTimeout(r, 20));
      open--;
      throw new Error('ETIMEDOUT');
    }) as any;
    await discover({ timeoutMs: 50, fetchFn: slow });
    expect(peak).toBe(KNOWN.length);
  });
});

describe('the table itself', () => {
  it('gives every row a port and an OpenAI base path', () => {
    for (const s of KNOWN) {
      expect(s.port).toBeGreaterThan(0);
      expect(s.base).toBe('/v1');
      expect(s.name.length).toBeGreaterThan(0);
    }
  });

  it('claims a runtime is startable only where a CLI can start it', () => {
    // llama.cpp and vLLM have a CLI and still are not startable: launching
    // either needs a model path this wizard does not have and must not guess.
    for (const s of KNOWN) {
      if (s.startable) expect(s.cli).not.toBe(null);
    }
    expect(KNOWN.filter(s => s.startable).map(s => s.id)).toEqual(['lmstudio']);
  });

  it('has one row per port, so two rows cannot both claim one server', () => {
    const ports = KNOWN.map(s => s.port);
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe('ENGINE_PORTS', () => {
  it('adds a port the table does not know, on the same terms as any other', async () => {
    // The table is short by choice and the list of local inference servers is
    // not. This is the escape hatch, and it buys no extra trust: the server
    // still has to answer with a model list, and is still never named.
    const specs = extraSpecs({ ENGINE_PORTS: '9000' } as any);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ id: 'unknown', port: 9000, base: '/v1', startable: false });

    const s = server({ 'http://localhost:9000/v1/models': MODELS('house-model') });
    const f = await probeSpec(specs[0], 'localhost', 100, s.fn);
    expect(f!.identified).toBe(false);
    // No runtime behind the name, so no default port to attribute it to.
    expect(describeFound(f!)).toBe('an OpenAI-compatible server on http://localhost:9000');
  });

  it('refuses a port the table already owns, so two rows cannot race for one server', () => {
    expect(extraSpecs({ ENGINE_PORTS: '1234,5001' } as any)).toEqual([]);
  });

  it('ignores anything that is not a usable port number', () => {
    expect(extraSpecs({ ENGINE_PORTS: 'nine thousand, -1, 0, 70000, ' } as any)).toEqual([]);
    expect(extraSpecs({} as any)).toEqual([]);
  });
});

describe('LMSTUDIO_URL', () => {
  it('still moves where LM Studio is looked for', () => {
    // Documented before this table existed. Moving discovery in here would
    // otherwise have quietly stopped honouring it, which is the kind of
    // regression nobody notices until an operator says nothing was found.
    const lms = KNOWN.find(s => s.id === 'lmstudio')!;
    expect(lms.port).toBe(process.env.LMSTUDIO_URL ? Number(new URL(process.env.LMSTUDIO_URL).port) : 1234);
  });
});
