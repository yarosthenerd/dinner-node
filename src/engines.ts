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

export async function* mock(prompt: string): AsyncGenerator<string> {
  const text = `Analyzing request "${prompt.slice(0, 60)}". This response is being served by idle hardware someone left on. Every token you read is a micropayment settling on Monad. At this rate the host machine funds its owner's dinner in roughly one streaming session. Proof: watch the settlement feed. `;
  for (const w of text.split(' ')) { yield w + ' '; await sleep(30); } // ~33 tok/s
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
export async function* ollama(prompt: string, model: string, signal?: AbortSignal, numCtx?: number): AsyncGenerator<string> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, prompt, stream: true, keep_alive: KEEP_ALIVE,
      ...(numCtx ? { options: { num_ctx: numCtx } } : {}),
    }), signal,
  });
  if (!res.ok || !res.body) throw new Error(`ollama ${res.status}`);
  for await (const l of lines(res.body)) {
    let j: any;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.response) yield j.response;
    if (j.done) return;
  }
}

export async function* openai(prompt: string, base: string, model: string, signal?: AbortSignal): AsyncGenerator<string> {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }), signal,
  });
  if (!res.ok || !res.body) throw new Error(`openai-compat ${res.status}`);
  for await (const l of lines(res.body)) {
    if (!l.startsWith('data: ')) continue;
    if (l === 'data: [DONE]') return;
    try {
      const d = JSON.parse(l.slice(6)).choices?.[0]?.delta?.content;
      if (d) yield d;
    } catch { continue; }
  }
}
