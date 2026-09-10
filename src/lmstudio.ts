/**
 * LM Studio as this node's engine.
 *
 * The second most common way a consumer machine already runs a local model,
 * and on a laptop that has one it is usually the ONLY one: an operator who
 * downloaded LM Studio, pulled 20 GB of weights through it and has them
 * working does not want to be told to install a second runtime and download
 * the same weights again. That is a step people stop at, and it is the step
 * this file removes.
 *
 * Nothing about the streaming path is new. LM Studio serves the
 * OpenAI-compatible wire on :1234, which `engines.ts` has spoken since the
 * `openai()` generator was written; what was missing was everything around it.
 * `host.ts` would only take that route if the operator already knew to set
 * LLM_BASE_URL by hand, and then registered on chain under the literal model
 * name "local", which is not a model and prices against nothing.
 *
 * So this file answers three questions ollama.ts already answers for ollama:
 * is it there, what does it hold, and can this process start it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { hasCommand } from './platform.js';

/**
 * Where LM Studio answers. The port is configurable in the app, and an
 * operator who moved it sets LMSTUDIO_URL; the default is what the app ships
 * with and what every LM Studio example on the internet uses.
 */
export const LMSTUDIO_URL = process.env.LMSTUDIO_URL ?? 'http://localhost:1234';

/** The OpenAI-compatible base, which is what LLM_BASE_URL has to hold. */
export const openaiBase = (url = LMSTUDIO_URL) => `${url.replace(/\/+$/, '')}/v1`;

export type LmModel = {
  id: string;
  /** True when the weights are resident. LM Studio also loads on demand. */
  loaded: boolean;
  /** The architecture's context length, tokens. 0 when not reported. */
  maxCtx: number;
  /** What the loaded instance actually serves, which can be far smaller. */
  loadedCtx: number;
  /** "llm", "embeddings" or "vlm". Only llm and vlm can serve a chat. */
  type: string;
};

export type LmProbe = {
  reachable: boolean;
  models: LmModel[];
  /**
   * Whether the richer native endpoint answered. When false the models were
   * read from /v1/models, which carries ids and nothing else, so every
   * context number is 0 and `loaded` is a guess rather than a fact.
   */
  detailed: boolean;
};

const EMPTY: LmProbe = { reachable: false, models: [], detailed: false };

/**
 * Is LM Studio answering, and what does it hold. Never throws.
 *
 * Two endpoints, tried in that order. `/api/v0/models` is LM Studio's own REST
 * API and reports `state`, `max_context_length` and `loaded_context_length`,
 * which are the three numbers that decide whether a model on this machine can
 * serve the context this node advertises. `/v1/models` is the OpenAI-shaped
 * fallback for an older build, and carries none of them.
 *
 * The distinction is kept rather than flattened because setup has to be able
 * to say "this model serves 4096 tokens, you are advertising 32768" instead of
 * guessing, and where it cannot know it must say that too.
 */
export async function probeLmStudio(
  url = LMSTUDIO_URL,
  timeoutMs = 4000,
  fetchFn: typeof fetch = fetch,
): Promise<LmProbe> {
  const base = url.replace(/\/+$/, '');

  try {
    const r = await fetchFn(`${base}/api/v0/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) {
      const body = await r.json() as any;
      const rows = Array.isArray(body?.data) ? body.data : [];
      return {
        reachable: true,
        detailed: true,
        models: rows.flatMap((m: any) => m?.id ? [{
          id: String(m.id),
          loaded: m.state === 'loaded',
          maxCtx: Number(m.max_context_length) || 0,
          loadedCtx: Number(m.loaded_context_length) || 0,
          type: String(m.type ?? 'llm'),
        }] : []),
      };
    }
  } catch { /* fall through to the OpenAI-shaped route */ }

  try {
    const r = await fetchFn(`${base}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return EMPTY;
    const body = await r.json() as any;
    const rows = Array.isArray(body?.data) ? body.data : [];
    return {
      reachable: true,
      detailed: false,
      // Every field but the id is unknown here, and is reported as unknown.
      // `loaded: true` would be a claim; 0 context is a readable absence.
      models: rows.flatMap((m: any) => m?.id
        ? [{ id: String(m.id), loaded: false, maxCtx: 0, loadedCtx: 0, type: 'llm' }]
        : []),
    };
  } catch {
    return EMPTY;
  }
}

/** Models this node could actually serve a chat from. */
export const servable = (models: LmModel[]) => models.filter(m => m.type !== 'embeddings');

/**
 * The model to serve when the operator has not chosen one.
 *
 * A loaded model wins over an unloaded one, because it is the one the operator
 * was last using and the one that costs nothing to start. Beyond that, the
 * largest advertised context, which is the closest thing to "most capable"
 * that this endpoint reports. Ties keep the server's own order.
 */
export function defaultModel(models: LmModel[]): string | null {
  const usable = servable(models);
  if (!usable.length) return null;
  const best = [...usable].sort((a, b) =>
    Number(b.loaded) - Number(a.loaded) || (b.maxCtx - a.maxCtx));
  return best[0].id;
}

/** Is the LM Studio CLI on this machine, whether or not the server is up. */
export const hasLmStudio = (has: (c: string) => boolean = hasCommand) => has('lms');

export type StartOptions = {
  url?: string;
  timeoutMs?: number;
  intervalMs?: number;
  log?: (line: string) => void;
  spawnFn?: typeof spawn;
  probeFn?: (url: string, timeoutMs: number) => Promise<LmProbe>;
  sleep?: (ms: number) => Promise<void>;
  /** Whether a command is on PATH. Injected so the spawn branch can be tested
   *  on a machine without the `lms` CLI, which is most machines including the
   *  CI runner. Left to the environment, the test for that branch asserted
   *  nothing anywhere. */
  hasCmd?: (cmd: string) => boolean;
};

const nap = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Start LM Studio's server and wait for it to answer.
 *
 * `lms server start` is the documented headless entry point and does not
 * require the desktop app to be open. Detached for the same reason
 * `startOllama` is: the server has to outlive setup, because the node started
 * immediately afterwards is what needs it.
 *
 * Deliberately not bound to 0.0.0.0. This node reaches its engine over
 * loopback, and a local inference server on the LAN is an unauthenticated one.
 */
export async function startLmStudio(opts: StartOptions = {}): Promise<LmProbe> {
  const {
    url = LMSTUDIO_URL, timeoutMs = 20_000, intervalMs = 500,
    log = () => {}, spawnFn = spawn, probeFn = probeLmStudio, sleep = nap,
    hasCmd = hasCommand,
  } = opts;

  if (!hasLmStudio(hasCmd)) return EMPTY;

  try {
    const port = new URL(url).port || '1234';
    const child: ChildProcess = spawnFn('lms', ['server', 'start', '--port', port], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref?.();
    log(`started the LM Studio server on :${port}`);
  } catch (e: any) {
    log(`could not start LM Studio: ${e?.message ?? e}`);
    return EMPTY;
  }

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(intervalMs);
    const p = await probeFn(url, 2000);
    if (p.reachable) return p;
  }
  return EMPTY;
}
