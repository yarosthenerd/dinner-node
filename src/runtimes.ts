/**
 * Every local LLM server this node can serve through, found rather than
 * configured.
 *
 * The supply side of this project is Windows and Linux machines with idle
 * discrete GPUs, and the people who own one and already run a model on it did
 * not all choose the same runtime. They chose the one that matched how they
 * arrived: a single portable exe with no installer, a desktop app, a compiled
 * binary they tuned themselves. Telling any of them to install a second
 * runtime and re-download twenty gigabytes of the same weights is the step
 * they stop at, and every one of those stops is a node this network does not
 * get.
 *
 * Nothing about the streaming path is new for any of them. They all speak
 * /v1/chat/completions, which engines.ts has spoken since the `openai()`
 * generator was written. What this file adds is the part that was missing:
 * knowing they are there.
 *
 * TWO RULES, and the whole design follows from them.
 *
 * A port does not identify a runtime. Four of the servers below default to
 * :8080, and so does every second development server on a laptop. Finding JSON
 * on a port proves nothing, so a candidate is accepted only when its response
 * is shaped like an OpenAI model list, and it is NAMED only when an endpoint
 * unique to that runtime confirms it. Where no such endpoint exists the port
 * is reported as what it is, an unidentified OpenAI-compatible server, because
 * a confident wrong name here sends a paying node's traffic somewhere nobody
 * chose.
 *
 * Context is asked for wherever the runtime will say. It is the same defect in
 * each of them: the context a model is loaded with lives in the server, not in
 * the request, so a node advertising more than the server honours has its
 * prompts truncated in silence and is paid for answering a question the model
 * never fully saw. Ollama is the one runtime where this is fixable per
 * request; everywhere else the node's advertised figure is what has to move.
 */
import type { LmModel } from './lmstudio.js';
import { probeLmStudio, servable } from './lmstudio.js';

export type RuntimeId =
  | 'lmstudio' | 'llamacpp' | 'koboldcpp' | 'jan' | 'vllm' | 'textgen' | 'gpt4all' | 'unknown';

/** What a fingerprint endpoint was able to establish. */
export type Fingerprint = {
  /** Context the server actually serves, tokens. 0 when it did not say. */
  ctx: number;
  /** Version or build, for the line the operator reads. */
  detail?: string;
  /** The server says it wants a password, which this node does not have. */
  needsPassword?: boolean;
};

export type RuntimeSpec = {
  id: RuntimeId;
  name: string;
  /** The port it ships with. An operator who moved it sets LLM_BASE_URL. */
  port: number;
  /** Path of the OpenAI-compatible API under the origin. */
  base: string;
  /**
   * Command that proves it is installed on this machine, when there is one.
   * Null for the runtimes that are a file someone double-clicks: there is no
   * PATH entry to find, so "installed but not running" is a state that cannot
   * be detected for them at all. They are found running or not found.
   */
  cli: string | null;
  /** Whether this process can start it unattended. See `startable` below. */
  startable: boolean;
  /**
   * Proof that the server on this port is this runtime. Absent where the
   * runtime publishes no endpoint that distinguishes it, in which case the
   * port is a hint and nothing is claimed.
   */
  fingerprint?: (origin: string, fetchFn: typeof fetch, timeoutMs: number) => Promise<Fingerprint | null>;
  /** Models and their contexts, where the runtime says more than /v1/models. */
  models?: (origin: string, fetchFn: typeof fetch, timeoutMs: number) => Promise<LmModel[] | null>;
};

export type Found = {
  spec: RuntimeSpec;
  /** http://host:port */
  origin: string;
  /** What LLM_BASE_URL has to hold. */
  base: string;
  /** A fingerprint confirmed this is the runtime named in `spec`. */
  identified: boolean;
  models: LmModel[];
  /** Server-wide context, tokens. 0 when nothing reported one. */
  ctx: number;
  detail: string;
  needsPassword: boolean;
};

const json = async (url: string, fetchFn: typeof fetch, timeoutMs: number): Promise<any | null> => {
  try {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
};

/**
 * The OpenAI model list, and the shape check that stands in for "is this
 * really an inference server".
 *
 * `{ data: [{ id: string }] }` is thin evidence and it is the only evidence
 * the wire offers. It is enough to reject the things actually on these ports:
 * a development server returns HTML or a 404, and neither survives the parse.
 * A server that passes this and is not an engine will fail on the first
 * completion, which is a loud failure at a moment nobody is paying.
 */
export async function openaiModels(base: string, fetchFn: typeof fetch, timeoutMs: number): Promise<string[] | null> {
  const body = await json(`${base}/models`, fetchFn, timeoutMs);
  if (!body || !Array.isArray(body.data)) return null;
  const ids = body.data.map((m: any) => m?.id).filter((x: any) => typeof x === 'string' && x);
  return ids.length ? ids : null;
}

/**
 * llama.cpp's llama-server. `/props` is its own endpoint and no other runtime
 * here answers it, so it is both the proof and the context reading:
 * `default_generation_settings.n_ctx` is what the loaded model is serving.
 */
async function llamacppFingerprint(origin: string, fetchFn: typeof fetch, timeoutMs: number): Promise<Fingerprint | null> {
  const p = await json(`${origin}/props`, fetchFn, timeoutMs);
  if (!p || typeof p !== 'object') return null;
  // Both keys are llama-server's; requiring one of the two rather than both
  // keeps this working across builds that dropped or renamed the other.
  if (p.default_generation_settings === undefined && p.build_info === undefined) return null;
  const ctx = Number(p.default_generation_settings?.n_ctx) || 0;
  return { ctx, detail: typeof p.build_info === 'string' ? p.build_info : undefined };
}

/**
 * KoboldCpp. `/api/extra/version` returns `{"result":"KoboldCpp", ...}`, which
 * is the least ambiguous fingerprint of any runtime here, and the capability
 * object it comes in also says whether the instance is password protected.
 * That last field matters: a protected instance refuses this node's requests,
 * and finding that out at setup is far better than finding it out when a guest
 * has already paid.
 */
async function koboldFingerprint(origin: string, fetchFn: typeof fetch, timeoutMs: number): Promise<Fingerprint | null> {
  const v = await json(`${origin}/api/extra/version`, fetchFn, timeoutMs);
  if (v?.result !== 'KoboldCpp') return null;
  // Advertised separately from the horde-facing figure, and it is the real one.
  const c = await json(`${origin}/api/extra/true_max_context_length`, fetchFn, timeoutMs);
  return {
    ctx: Number(c?.value) || 0,
    detail: v.version ? `v${v.version}` : undefined,
    // `llm: false` is a KoboldCpp serving images or speech and no text model.
    needsPassword: Boolean(v.protected),
  };
}

/** LM Studio, whose richer endpoint reports per-model state and context. */
async function lmstudioModels(origin: string, fetchFn: typeof fetch, timeoutMs: number): Promise<LmModel[] | null> {
  const p = await probeLmStudio(origin, timeoutMs, fetchFn);
  return p.reachable && p.detailed ? p.models : null;
}

async function lmstudioFingerprint(origin: string, fetchFn: typeof fetch, timeoutMs: number): Promise<Fingerprint | null> {
  const p = await probeLmStudio(origin, timeoutMs, fetchFn);
  if (!p.reachable || !p.detailed) return null;
  // Server-wide context is not a thing LM Studio has; it is per loaded model,
  // and the model rows carry it. The largest loaded one stands in here.
  const ctx = Math.max(0, ...servable(p.models).map(m => m.loadedCtx || 0));
  return { ctx };
}

/** The port out of a URL, or the default when it is unset or unparseable. */
function portOf(url: string | undefined, dflt: number): number {
  if (!url) return dflt;
  try { return Number(new URL(url).port) || dflt; } catch { return dflt; }
}

/**
 * The table. One row per runtime, ordered by how likely it is that the machine
 * this wizard is running on has it.
 *
 * Adding a runtime is a row. Adding one that publishes no fingerprint is a row
 * with no fingerprint, and it will be found and reported honestly as
 * unidentified rather than left undiscovered.
 */
export const KNOWN: RuntimeSpec[] = [
  {
    // LMSTUDIO_URL is read here rather than ignored: it is the documented way
    // to say "mine is not on the port it ships with", and moving discovery
    // into this table would otherwise have quietly stopped honouring it.
    id: 'lmstudio', name: 'LM Studio', port: portOf(process.env.LMSTUDIO_URL, 1234), base: '/v1',
    cli: 'lms', startable: true,
    fingerprint: lmstudioFingerprint, models: lmstudioModels,
  },
  {
    id: 'koboldcpp', name: 'KoboldCpp', port: 5001, base: '/v1',
    // One file, zero install, and usually not on the PATH. It is found
    // running or not found.
    cli: null, startable: false,
    fingerprint: koboldFingerprint,
  },
  {
    id: 'llamacpp', name: 'llama.cpp (llama-server)', port: 8080, base: '/v1',
    // Installed as a binary, but starting it needs a model path this wizard
    // does not have and must not guess at.
    cli: 'llama-server', startable: false,
    fingerprint: llamacppFingerprint,
  },
  {
    id: 'jan', name: 'Jan', port: 1337, base: '/v1',
    cli: null, startable: false,
  },
  {
    id: 'vllm', name: 'vLLM', port: 8000, base: '/v1',
    cli: 'vllm', startable: false,
  },
  {
    id: 'textgen', name: 'text-generation-webui', port: 5000, base: '/v1',
    cli: null, startable: false,
  },
  {
    id: 'gpt4all', name: 'GPT4All', port: 4891, base: '/v1',
    cli: null, startable: false,
  },
];

/**
 * Ports named by the operator in ENGINE_PORTS, on top of the table.
 *
 * The table is short by choice and the list of local inference servers is not.
 * Rather than grow it with rows nobody can keep true, an operator running
 * something it does not know sets `ENGINE_PORTS=9000,9001` and this node finds
 * it, on exactly the same terms as an unfingerprinted row: accepted only if it
 * answers with an OpenAI model list, and never named.
 *
 * A port already in the table is dropped, so naming 1234 cannot produce two
 * rows racing to describe one LM Studio.
 */
export function extraSpecs(env: NodeJS.ProcessEnv = process.env): RuntimeSpec[] {
  const taken = new Set(KNOWN.map(s => s.port));
  return (env.ENGINE_PORTS ?? '')
    .split(',')
    .map(p => Number(p.trim()))
    .filter(p => Number.isInteger(p) && p > 0 && p < 65536 && !taken.has(p))
    .map(port => ({
      id: 'unknown' as const,
      name: `the server on :${port}`,
      port, base: '/v1', cli: null, startable: false,
    }));
}

export type DiscoverOptions = {
  host?: string;
  /** Short by default: these are loopback ports, and setup waits on this. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  specs?: RuntimeSpec[];
};

/**
 * Everything answering on this machine, probed in parallel.
 *
 * Parallel because it is seven loopback requests against ports that are mostly
 * closed, and a closed port refuses immediately. Run in series with a timeout
 * each, a machine behind a filtering firewall would add seven timeouts to the
 * front of every setup run.
 */
export async function discover(opts: DiscoverOptions = {}): Promise<Found[]> {
  const { host = 'localhost', timeoutMs = 2500, fetchFn = fetch, specs = [...KNOWN, ...extraSpecs()] } = opts;
  const found = await Promise.all(specs.map(s => probeSpec(s, host, timeoutMs, fetchFn)));
  return found.filter((f): f is Found => f !== null);
}

/** One runtime, at the port it ships with. Never throws. */
export async function probeSpec(
  spec: RuntimeSpec,
  host = 'localhost',
  timeoutMs = 2500,
  fetchFn: typeof fetch = fetch,
): Promise<Found | null> {
  const origin = `http://${host}:${spec.port}`;
  const base = `${origin}${spec.base}`;

  // The shape check first, and it is what decides whether anything here is an
  // engine at all. A fingerprint that answered on a port with no model list is
  // a server that cannot serve a job.
  const ids = await openaiModels(base, fetchFn, timeoutMs);
  if (!ids) return null;

  const fp = spec.fingerprint ? await spec.fingerprint(origin, fetchFn, timeoutMs) : null;
  const detailed = spec.models ? await spec.models(origin, fetchFn, timeoutMs) : null;

  // Server-wide context applies to every model the server holds, so it is
  // written onto each row that does not carry its own. That is what lets setup
  // ask one question about context regardless of which runtime answered.
  const ctx = fp?.ctx ?? 0;
  const models: LmModel[] = detailed ?? ids.map(id => ({
    id, loaded: false, maxCtx: ctx, loadedCtx: ctx, type: 'llm',
  }));

  return {
    spec, origin, base,
    identified: fp !== null,
    models,
    ctx,
    detail: fp?.detail ?? '',
    needsPassword: Boolean(fp?.needsPassword),
  };
}

/**
 * How to name what was found, to an operator reading one line of output.
 *
 * The distinction between a confirmed runtime and a port that merely answered
 * is carried into the text rather than flattened, because the second one is a
 * guess and the operator is the only one who can settle it.
 */
export function describe(f: Found): string {
  if (f.identified) return `${f.spec.name}${f.detail ? ` ${f.detail}` : ''} on ${f.origin}`;
  // A row from ENGINE_PORTS has no runtime behind its name, so there is no
  // default port to attribute it to. It is simply a server the operator
  // pointed at, which is all that can honestly be said.
  if (f.spec.id === 'unknown') return `an OpenAI-compatible server on ${f.origin}`;
  return `an OpenAI-compatible server on ${f.origin}` +
    ` (that is ${f.spec.name}'s default port, but nothing confirmed it)`;
}
