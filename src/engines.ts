const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// A network chunk is not a line. Splitting each chunk on "\n" without carrying
// the remainder forward tears JSON objects in half at chunk boundaries, and the
// resulting parse throws out of the generator and truncates the answer. The
// longer the output, the likelier this is, so every reader below buffers.
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  // Cast through unknown: node's WritableStream<BufferSource> and the DOM
  // lib's WritableStream<Uint8Array> describe the same runtime object, and
  // the two lib definitions do not agree structurally. This is a typings
  // mismatch, not a behavioural one.
  const reader = ((body as unknown as ReadableStream).pipeThrough(new TextDecoderStream()) as any).getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l.trim()) yield l;
    }
  }
  if (buf.trim()) yield buf;
}

/**
 * One frame from an engine.
 *
 * `t` is visible output: it is billed, it enters the checkpoint chain, and it
 * is what the guest reads. `th` is the model's reasoning, which a reasoning
 * model produces for 15 to 47 seconds before the first visible character on
 * the reference node. Separating them at the source is what lets the host
 * forward proof-of-life to the browser without either billing for it or
 * putting it in a hash the next provider has to reproduce.
 */
export type Chunk = { t: string; th?: never } | { th: string; t?: never };

export async function* mock(prompt: string): AsyncGenerator<Chunk> {
  const text = `Analyzing request "${prompt.slice(0, 60)}". This response is being served by idle hardware someone left on. Every token you read is a micropayment settling on Monad. At this rate the host machine funds its owner's dinner in roughly one streaming session. Proof: watch the settlement feed. `;
  for (const w of text.split(' ')) { yield { t: w + ' ' }; await sleep(30); } // ~33 tok/s
}

// Ollama unloads a model after five minutes idle by default, and a 27B evicting
// whatever else is resident costs about 48 seconds to first token on the
// reference laptop. That is most of the guest's patience spent before a single
// token, on every job that arrives more than five minutes after the last one.
// Holding the model resident turns that into a one-off cost at startup.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '30m';

// num_ctx must be sent explicitly. Ollama does NOT use the architecture's
// context length: it applies the server default (4096) unless the model's
// Modelfile sets num_ctx or the request overrides it. The tag this node serves,
// qwen3.8:27b, carries no num_ctx, so the whole stack was advertising a 30720
// token prompt budget while ollama silently truncated anything past the default.
// Silently is the problem: a truncated prompt returns a confident answer to a
// question the model never fully saw. Sending it per request ties what is served
// to CONTEXT_TOKENS, the same number /health advertises, so the two cannot drift.
// A serving instruction, applied by this node to every job it takes.
//
// Reasoning models open with a knowledge-cutoff hedge unprompted: the first
// answer served from this node began "as of 2024-2025", which reads as a stale
// machine rather than as an answer. The instruction below is deliberately NOT
// "never mention your cutoff". Suppressing the caveat outright would push the
// model to state dated figures as current, which is a worse failure than an
// awkward opening. It says where the caveat belongs instead: at the point it
// affects an answer, not as a preamble to every answer.
//
// Operators can replace it. A node serving a specialised model may want
// something else entirely, and nothing here depends on the default text.
export const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ?? [
  'Answer directly. Do not open with a disclaimer about your training data or knowledge cutoff.',
  'If the answer genuinely depends on information that may have changed, say so in one short clause at the point it matters, and give your best current figure anyway.',
  'Do not preface answers with dates, hedges, or apologies for what you might not know.',
].join(' ');

/**
 * `think` controls whether the model reasons before answering.
 *
 * It matters far more than it looks. Measured on qwen3.6:35b-a3b 2026-08-27
 * with an identical short prompt: 317 thinking frames against 25 visible with
 * thinking on, and 0 against 32 with it off. Reasoning is billed here, so a
 * bounded sub-task that reasons costs roughly thirteen times what it needs to
 * and can spend an entire step ceiling before producing a word.
 *
 * Left ON for a guest's own prompt, where the reasoning is streamed, disclosed
 * and part of what they are buying. Turned OFF for plan steps, which are
 * bounded pieces of work under a ceiling the guest approved in advance.
 */
export async function* ollama(prompt: string, model: string, signal?: AbortSignal, numCtx?: number, system: string = SYSTEM_PROMPT, think = true): AsyncGenerator<Chunk> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, prompt, stream: true, keep_alive: KEEP_ALIVE,
      // Only sent when disabling it: a model with no thinking mode rejects an
      // unexpected parameter, and `think: true` is already the default for one
      // that has it.
      ...(think ? {} : { think: false }),
      // Sent as `system` rather than glued onto the prompt, so the guest's
      // prompt reaches the model exactly as it was committed on chain, and so
      // the instruction cannot be mistaken for guest text by anything reading
      // the request. Its tokens still consume context, which is why host.ts
      // charges them against PROMPT_BUDGET.
      ...(system ? { system } : {}),
      ...(numCtx ? { options: { num_ctx: numCtx } } : {}),
    }), signal,
  });
  if (!res.ok || !res.body) throw new Error(`ollama ${res.status}`);
  for await (const l of lines(res.body)) {
    let j: any;
    try { j = JSON.parse(l); } catch { continue; }
    // Ollama returns reasoning in its own field, never in `response`. Yielding
    // it as a distinct frame is what stops it being billed or checkpointed
    // while still letting the host prove the engine is alive.
    if (j.thinking) yield { th: j.thinking };
    if (j.response) yield { t: j.response };
    if (j.done) return;
  }
}

export async function* openai(prompt: string, base: string, model: string, signal?: AbortSignal): AsyncGenerator<Chunk> {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [
      ...(SYSTEM_PROMPT ? [{ role: 'system', content: SYSTEM_PROMPT }] : []),
      { role: 'user', content: prompt },
    ] }), signal,
  });
  if (!res.ok || !res.body) throw new Error(`openai-compat ${res.status}`);
  for await (const l of lines(res.body)) {
    if (!l.startsWith('data: ')) continue;
    if (l === 'data: [DONE]') return;
    try {
      const delta = JSON.parse(l.slice(6)).choices?.[0]?.delta;
      // There is no standard field name for reasoning on the OpenAI-compatible
      // wire. OpenRouter sends `reasoning`, vLLM and DeepSeek send
      // `reasoning_content`. Accept both; a server that sends neither simply
      // produces no thinking frames.
      const r = delta?.reasoning ?? delta?.reasoning_content;
      if (r) yield { th: String(r) };
      if (delta?.content) yield { t: delta.content };
    } catch { continue; }
  }
}
