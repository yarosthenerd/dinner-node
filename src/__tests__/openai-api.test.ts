import { describe, expect, it } from 'vitest';
import {
  authorize, chunk, completion, DONE, errorBody, errorChunk,
  flattenMessages, modelsBody, parseChat, parseKeys, usage, usageChunk,
} from '../openai-api';

const parse = (body: unknown, ceiling = 2048) =>
  parseChat(typeof body === 'string' ? body : JSON.stringify(body), { maxTokensCeiling: ceiling });

const rejOf = (r: ReturnType<typeof parse>) => {
  if (r.ok) throw new Error('expected a rejection');
  return { status: r.rej.status, ...JSON.parse(r.rej.body).error };
};

describe('the API key check', () => {
  it('accepts a configured key and rejects everything else', () => {
    const keys = parseKeys(' dn-alpha , dn-beta ,, ');
    expect(keys).toEqual(['dn-alpha', 'dn-beta']);
    expect(authorize('Bearer dn-beta', keys)).toBe(true);
    expect(authorize('bearer dn-alpha', keys)).toBe(true);
    expect(authorize('Bearer dn-gamma', keys)).toBe(false);
    // A prefix of a real key is not a real key. The comparison is over
    // digests, so length tells an attacker nothing either.
    expect(authorize('Bearer dn-alph', keys)).toBe(false);
    expect(authorize('dn-alpha', keys)).toBe(false);
    expect(authorize(undefined, keys)).toBe(false);
  });

  it('refuses everyone when no keys are configured', () => {
    // The default state of a node whose operator never set API_KEYS. Closed is
    // the only safe reading, because this path spends the node's own deposit.
    expect(authorize('Bearer anything', parseKeys(undefined))).toBe(false);
    expect(authorize('Bearer anything', [])).toBe(false);
  });
});

describe('flattening a conversation into one prompt', () => {
  it('sends a single user turn as the bare text', () => {
    // The common case has to reach the model exactly as /job would have sent
    // it, or the two paths answer the same question differently.
    const f = flattenMessages([{ role: 'user', content: 'how much is dinner' }]);
    expect(f).toEqual({ prompt: 'how much is dinner' });
  });

  it('labels the turns of a multi-turn conversation', () => {
    const f = flattenMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]) as { prompt: string };
    expect(f.prompt).toBe('User: first\n\nAssistant: second\n\nUser: third');
  });

  it('folds a system message into the prompt as context', () => {
    // It cannot displace the operator's serving instruction, which ollama
    // receives in its own field. Written down here so the limitation is a
    // recorded choice rather than a surprise.
    const f = flattenMessages([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'why' },
    ]) as { prompt: string };
    expect(f.prompt).toBe('be terse\n\nwhy');
  });

  it('reads text content parts and refuses the rest', () => {
    const ok = flattenMessages([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
    expect(ok).toEqual({ prompt: 'ab' });
    // An image dropped in silence would produce a confident answer about a
    // picture this node never saw.
    const bad = flattenMessages([{ role: 'user', content: [{ type: 'image_url' }] }]) as any;
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error.code).toBe('unsupported_content_part');
  });

  it('rejects an empty or roleless message list', () => {
    expect((flattenMessages([]) as any).status).toBe(400);
    expect((flattenMessages('hello') as any).status).toBe(400);
    expect((flattenMessages([{ content: 'no role' }]) as any).status).toBe(400);
    expect((flattenMessages([{ role: 'system', content: 'only a system message' }]) as any).status).toBe(400);
  });
});

describe('parsing a chat request', () => {
  it('ignores sampling fields it does not implement', () => {
    // A client sending temperature should get an answer rather than a 400.
    const r = parse({ model: null, messages: [{ role: 'user', content: 'hi' }], temperature: 0.7, top_p: 0.9, seed: 3 });
    expect(r.ok).toBe(true);
  });

  it('fails loudly on the fields that would change the answer', () => {
    expect(rejOf(parse({ messages: [{ role: 'user', content: 'hi' }], tools: [{}] })).code).toBe('unsupported_field');
    expect(rejOf(parse({ messages: [{ role: 'user', content: 'hi' }], n: 2 })).code).toBe('unsupported_field');
    expect(rejOf(parse({ messages: [{ role: 'tool', content: 'x' }] })).code).toBe('unsupported_role');
    expect(rejOf(parse('not json')).code).toBe('invalid_json');
    expect(rejOf(parse('[1,2]')).code).toBe('invalid_json');
  });

  it('clamps max_tokens to the node ceiling and takes the smaller of the two spellings', () => {
    const big = parse({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 999999 }, 2048);
    expect(big.ok && big.req.maxTokens).toBe(2048);
    const both = parse({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 300, max_completion_tokens: 120 }, 2048);
    expect(both.ok && both.req.maxTokens).toBe(120);
    // No ceiling asked for still gets one: the escrow behind the job is finite.
    const none = parse({ messages: [{ role: 'user', content: 'hi' }] }, 512);
    expect(none.ok && none.req.maxTokens).toBe(512);
    expect(rejOf(parse({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 0 })).code).toBe('invalid_max_tokens');
  });

  it('reads streaming and usage flags', () => {
    const a = parse({ messages: [{ role: 'user', content: 'hi' }] });
    expect(a.ok && a.req.stream).toBe(false);
    expect(a.ok && a.req.includeUsage).toBe(false);
    const b = parse({ messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } });
    expect(b.ok && b.req.stream).toBe(true);
    expect(b.ok && b.req.includeUsage).toBe(true);
    // Usage is a streaming option. Asked for without streaming it means
    // nothing, because a buffered response always carries usage.
    const c = parse({ messages: [{ role: 'user', content: 'hi' }], stream_options: { include_usage: true } });
    expect(c.ok && c.req.includeUsage).toBe(false);
  });
});

describe('usage', () => {
  it('reports billed output and estimated input', () => {
    // completion_tokens is what settle() charges: visible plus reasoning.
    // prompt_tokens is an estimate and is charged at zero.
    expect(usage(400, 96)).toEqual({ prompt_tokens: 400, completion_tokens: 96, total_tokens: 496 });
  });
});

describe('the wire frames', () => {
  const read = (f: string) => JSON.parse(f.replace(/^data: /, '').trim());

  it('frames a delta as a chat.completion.chunk', () => {
    const f = chunk('chatcmpl-dn7', 1000, 'qwen3.8:27b', { content: 'hi' });
    expect(f.startsWith('data: ')).toBe(true);
    expect(f.endsWith('\n\n')).toBe(true);
    const j = read(f);
    expect(j.object).toBe('chat.completion.chunk');
    expect(j.choices[0].delta).toEqual({ content: 'hi' });
    expect(j.choices[0].finish_reason).toBe(null);
  });

  it('carries reasoning under the field an aggregator reads', () => {
    expect(read(chunk('id', 1, 'm', { reasoning: 'thinking' })).choices[0].delta.reasoning).toBe('thinking');
  });

  it('sends usage in a chunk with no choices, per the streaming spec', () => {
    const j = read(usageChunk('id', 1, 'm', usage(10, 5)));
    expect(j.choices).toEqual([]);
    expect(j.usage.total_tokens).toBe(15);
  });

  it('has a terminator a stock client stops on', () => {
    expect(DONE).toBe('data: [DONE]\n\n');
  });

  it('reports a mid-stream failure in a frame, since the status is already sent', () => {
    expect(read(errorChunk('ollama 500')).error.code).toBe('engine_error');
  });

  it('builds a buffered completion with the finish reason and usage', () => {
    const j = JSON.parse(completion('chatcmpl-dn7', 1000, 'qwen3.8:27b', 'answer', 'thought', usage(12, 3), 'length'));
    expect(j.object).toBe('chat.completion');
    expect(j.choices[0].message).toEqual({ role: 'assistant', content: 'answer', reasoning: 'thought' });
    expect(j.choices[0].finish_reason).toBe('length');
    expect(j.usage.completion_tokens).toBe(3);
    // A model that produced no reasoning does not get an empty field.
    expect(JSON.parse(completion('i', 1, 'm', 'a', '', usage(1, 1), 'stop')).choices[0].message.reasoning).toBeUndefined();
  });

  it('uses the OpenAI error envelope, which is the shape clients parse', () => {
    expect(JSON.parse(errorBody('nope', 'invalid_request_error', 'model_not_found', 'model'))).toEqual({
      error: { message: 'nope', type: 'invalid_request_error', param: 'model', code: 'model_not_found' },
    });
  });

  it('lists every id this node answers to', () => {
    const j = JSON.parse(modelsBody(['qwen3.8:27b', 'qwen/qwen3.6-35b-a3b'], '0xabc', 1000));
    expect(j.object).toBe('list');
    expect(j.data.map((m: any) => m.id)).toEqual(['qwen3.8:27b', 'qwen/qwen3.6-35b-a3b']);
    expect(j.data[0].owned_by).toBe('0xabc');
  });
});
