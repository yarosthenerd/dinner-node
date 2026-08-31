/**
 * OpenAI-compatible request parsing and response framing.
 *
 * Deliberately free of every project import. It touches no wallet, no engine
 * and no chain, so it can be unit tested the way `billing.ts` and `plan.ts`
 * are, while `host.ts` keeps sole ownership of the money and the stream.
 *
 * The target is the subset of `/v1/chat/completions` that an aggregator and
 * the stock OpenAI clients actually send: messages, stream, stream_options,
 * max_tokens. Anything else is accepted and ignored rather than rejected,
 * because a client that sends `temperature` should get an answer, not a 400.
 * What is NOT supported fails loudly instead of silently: tools, function
 * calling, images and `n` > 1 all return an error naming the field, since
 * quietly dropping them would return a confident answer to a request the
 * caller did not make.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export type ContentPart = { type?: unknown; text?: unknown };
export type ChatMessage = { role?: unknown; content?: unknown };

export type ChatRequest = {
  /** What the caller asked for. Recorded so the response can echo it. */
  model: string | null;
  /** The flattened conversation, ready for a single-string engine. */
  prompt: string;
  stream: boolean;
  /** Only true when the caller sent stream_options.include_usage. */
  includeUsage: boolean;
  /** Visible-token ceiling for this request, or null for the node default. */
  maxTokens: number | null;
};

export type Rejection = { status: number; body: string };
export type Parsed = { ok: true; req: ChatRequest } | { ok: false; rej: Rejection };

/** The OpenAI error envelope. Clients parse this shape; a bare string breaks them. */
export function errorBody(message: string, type: string, code: string, param: string | null = null): string {
  return JSON.stringify({ error: { message, type, param, code } });
}

const bad = (message: string, code: string, param: string | null = null): Rejection =>
  ({ status: 400, body: errorBody(message, 'invalid_request_error', code, param) });

/**
 * Constant-time API key check.
 *
 * Both sides are hashed first so the comparison is over two 32-byte buffers
 * whatever the lengths were. Comparing the raw strings would leak the key
 * length and, with `===`, the length of the matching prefix.
 */
export function authorize(header: string | undefined, keys: string[]): boolean {
  if (!keys.length) return false;
  const m = /^Bearer\s+(.+)$/i.exec((header ?? '').trim());
  if (!m) return false;
  const got = createHash('sha256').update(m[1]).digest();
  let ok = false;
  // Every key is checked even after a match, so the time taken does not depend
  // on the position of the matching key in the list.
  for (const k of keys) ok = timingSafeEqual(got, createHash('sha256').update(k).digest()) || ok;
  return ok;
}

export function parseKeys(csv: string | undefined): string[] {
  return (csv ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/** `content` is a string in most requests and an array of parts in some. */
function partText(content: unknown, where: string): string | Rejection {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (!Array.isArray(content)) return bad(`${where}.content must be a string or an array of content parts`, 'invalid_content', where);
  const out: string[] = [];
  for (const p of content as ContentPart[]) {
    const t = p?.type;
    if (t === 'text' || t === 'input_text') { out.push(String(p?.text ?? '')); continue; }
    // Naming the part is the point. A node that silently dropped an image
    // would answer a question about a picture it never saw.
    return bad(`${where}.content part of type "${String(t)}" is not supported by this node; text only`, 'unsupported_content_part', where);
  }
  return out.join('');
}

const isRejection = (v: unknown): v is Rejection =>
  typeof v === 'object' && v !== null && 'status' in (v as any) && 'body' in (v as any);

/**
 * Flatten a message array into the single prompt string the engines take.
 *
 * `src/engines.ts` generates from one string plus the operator's own system
 * instruction, which ollama receives in its `system` field. A caller's system
 * message therefore cannot displace the operator's: it is folded into the
 * prompt as context and labelled as coming from the caller. That is a real
 * limitation and it is written down here rather than discovered from a model
 * that ignored an instruction the caller believed was authoritative.
 */
export function flattenMessages(messages: unknown): { prompt: string } | Rejection {
  if (!Array.isArray(messages) || messages.length === 0) {
    return bad('messages must be a non-empty array', 'missing_messages', 'messages');
  }
  const pre: string[] = [];
  const turns: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as ChatMessage;
    const where = `messages[${i}]`;
    const role = typeof m?.role === 'string' ? m.role : null;
    if (!role) return bad(`${where}.role is required`, 'missing_role', where);
    const text = partText(m?.content, where);
    if (isRejection(text)) return text;
    if (role === 'system' || role === 'developer') { if (text.trim()) pre.push(text.trim()); continue; }
    if (role === 'user') { turns.push(`User: ${text}`); continue; }
    if (role === 'assistant') { turns.push(`Assistant: ${text}`); continue; }
    if (role === 'tool' || role === 'function') {
      return bad('tool and function messages are not supported by this node', 'unsupported_role', where);
    }
    return bad(`${where}.role "${role}" is not supported`, 'unsupported_role', where);
  }
  if (!turns.length) return bad('messages must contain at least one user or assistant message', 'missing_messages', 'messages');
  // A single user turn is sent as the bare text, so the common case reaches the
  // model exactly as `/job` would have sent it and the two paths produce the
  // same answer for the same question.
  const body = turns.length === 1 && turns[0].startsWith('User: ') ? turns[0].slice(6) : turns.join('\n\n');
  const prompt = pre.length ? `${pre.join('\n\n')}\n\n${body}` : body;
  return { prompt };
}

export function parseChat(raw: string, opts: { maxTokensCeiling: number }): Parsed {
  let j: any;
  try { j = JSON.parse(raw || ''); } catch { return { ok: false, rej: bad('request body is not valid JSON', 'invalid_json') }; }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) {
    return { ok: false, rej: bad('request body must be a JSON object', 'invalid_json') };
  }
  if (j.tools || j.functions || j.tool_choice) {
    return { ok: false, rej: bad('tool calling is not supported by this node', 'unsupported_field', 'tools') };
  }
  if (j.n !== undefined && Number(j.n) !== 1) {
    return { ok: false, rej: bad('only n = 1 is supported: each completion is a separately settled job', 'unsupported_field', 'n') };
  }
  const f = flattenMessages(j.messages);
  if (isRejection(f)) return { ok: false, rej: f };

  let maxTokens: number | null = null;
  // max_completion_tokens is the current name; max_tokens is what most clients
  // still send. Accept both and take the smaller when a client sends both.
  for (const v of [j.max_tokens, j.max_completion_tokens]) {
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) return { ok: false, rej: bad('max_tokens must be a positive integer', 'invalid_max_tokens', 'max_tokens') };
    maxTokens = maxTokens === null ? Math.floor(n) : Math.min(maxTokens, Math.floor(n));
  }
  // The node's ceiling wins. It is what the escrow opened for this job can pay
  // for, so a caller asking for more would be quoted a limit the money behind
  // the job cannot honour.
  if (maxTokens === null || maxTokens > opts.maxTokensCeiling) maxTokens = opts.maxTokensCeiling;

  return {
    ok: true,
    req: {
      model: typeof j.model === 'string' ? j.model : null,
      prompt: f.prompt,
      stream: j.stream === true,
      includeUsage: j.stream === true && j.stream_options?.include_usage === true,
      maxTokens,
    },
  };
}

// ---- response framing ------------------------------------------------------

export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
export type Finish = 'stop' | 'length' | 'error';

/**
 * Usage.
 *
 * `completion_tokens` is the figure this node BILLED, which is visible output
 * plus reasoning, the same number that reaches `settle()`. `prompt_tokens` is
 * an estimate at roughly four characters per token and is charged at zero:
 * settle() bills tokensDelta, which counts only what the node generated. The
 * two fields therefore mean different things here, and the estimate is never
 * the basis of a charge.
 */
export function usage(promptTokens: number, billed: number): Usage {
  return { prompt_tokens: promptTokens, completion_tokens: billed, total_tokens: promptTokens + billed };
}

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

export const DONE = 'data: [DONE]\n\n';

export function chunk(id: string, created: number, model: string, delta: Record<string, unknown>, finish: Finish | null = null): string {
  return frame({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  });
}

/**
 * The usage-only chunk. Per the streaming spec a client that asked for usage
 * gets it in a final chunk carrying an empty `choices` array.
 */
export function usageChunk(id: string, created: number, model: string, u: Usage): string {
  return frame({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: u });
}

/** A mid-stream failure. There is no status code left to send, so it goes in a frame. */
export function errorChunk(message: string): string {
  return frame({ error: { message, type: 'server_error', param: null, code: 'engine_error' } });
}

export function completion(
  id: string, created: number, model: string,
  content: string, reasoning: string, u: Usage, finish: Finish,
): string {
  return JSON.stringify({
    id, object: 'chat.completion', created, model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content,
        // OpenRouter's field name, which is the one an aggregator reads. A
        // client that does not know it ignores it.
        ...(reasoning ? { reasoning } : {}),
      },
      finish_reason: finish, logprobs: null,
    }],
    usage: u,
  });
}

/**
 * The model list.
 *
 * A node serves exactly one model, and it is listed under every id it will
 * answer to: the engine's own tag, and the id of the market listing the price
 * was derived from when those differ. A client that reads this list can always
 * send a model string this node accepts.
 */
export function modelsBody(models: string[], owner: string, created: number): string {
  return JSON.stringify({
    object: 'list',
    data: models.map(id => ({ id, object: 'model', created, owned_by: owner })),
  });
}
