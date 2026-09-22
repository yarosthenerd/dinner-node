import { describe, expect, it, vi } from 'vitest';
import { ollama, openai, type Chunk } from '../engines.js';

/** A fetch that replays `lines` as one NDJSON/SSE body, split at awkward
 *  boundaries so the reader's buffering is exercised along with the parsing. */
function stubFetch(body: string, chunkSize = 7) {
  const enc = new TextEncoder();
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < body.length; i += chunkSize) c.enqueue(enc.encode(body.slice(i, i + chunkSize)));
        c.close();
      },
    }),
  }));
}

const drain = async (g: AsyncGenerator<Chunk>) => {
  const out: Chunk[] = [];
  for await (const c of g) out.push(c);
  return out;
};

const visible = (cs: Chunk[]) => cs.filter(c => c.t !== undefined).map(c => c.t).join('');
const reasoning = (cs: Chunk[]) => cs.filter(c => c.th !== undefined).map(c => c.th).join('');

describe('ollama frames', () => {
  // The defect this guards: reasoning arrives in its own field, and anything
  // that folds it into the visible stream both bills the guest for it and puts
  // it in the keccak prefix a replacement provider has to reproduce.
  it('separates thinking from visible output', async () => {
    stubFetch([
      JSON.stringify({ thinking: 'Let me ' }),
      JSON.stringify({ thinking: 'consider.' }),
      JSON.stringify({ response: 'Belgrade' }),
      JSON.stringify({ response: ' is cheap.' }),
      JSON.stringify({ done: true }),
    ].join('\n') + '\n');

    const cs = await drain(ollama('p', 'm'));
    expect(visible(cs)).toBe('Belgrade is cheap.');
    expect(reasoning(cs)).toBe('Let me consider.');
    // No frame is ever both, which is what lets the host branch on it.
    expect(cs.every(c => (c.t === undefined) !== (c.th === undefined))).toBe(true);
  });

  it('stops at done and yields nothing after it', async () => {
    stubFetch([
      JSON.stringify({ response: 'a' }),
      JSON.stringify({ done: true }),
      JSON.stringify({ response: 'never' }),
    ].join('\n') + '\n');
    expect(visible(await drain(ollama('p', 'm')))).toBe('a');
  });
});

describe('openai-compatible frames', () => {
  // No standard name exists for this field on the OpenAI wire: OpenRouter
  // sends `reasoning`, vLLM and DeepSeek send `reasoning_content`.
  it('reads reasoning under either field name', async () => {
    stubFetch([
      'data: ' + JSON.stringify({ choices: [{ delta: { reasoning: 'hm ' } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'ok' } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }),
      'data: [DONE]',
    ].join('\n') + '\n');

    const cs = await drain(openai('p', 'http://x', 'm'));
    expect(reasoning(cs)).toBe('hm ok');
    expect(visible(cs)).toBe('answer');
  });

  it('serves a plain server that sends no reasoning at all', async () => {
    stubFetch([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'just text' } }] }),
      'data: [DONE]',
    ].join('\n') + '\n');
    const cs = await drain(openai('p', 'http://x', 'm'));
    expect(visible(cs)).toBe('just text');
    expect(cs.filter(c => c.th !== undefined)).toHaveLength(0);
  });
});
