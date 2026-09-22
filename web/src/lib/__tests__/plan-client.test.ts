/**
 * The node-facing plan client.
 *
 * `canonicalize` is the one that carries a guarantee rather than a convenience.
 * The guest commits a hash of the plan THEY were shown, computed here, so that
 * a node returning a planHash for different text than it displayed cannot get
 * that hash signed. src/__tests__/plan.test.ts asserts this file agrees with
 * src/plan.ts on real plans; what is asserted here is the properties the
 * canonical form has to have for that agreement to be worth anything.
 *
 * `readStream` is the SSE reader, and the chunk-boundary cases are the ones
 * that bite: a frame split across two network chunks must not be dropped, and
 * one torn frame must not throw away an answer the guest has already paid for.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import {
  canonicalize, planHash, planMaxTokens, readStream, requestPlan, runPlan, waves,
  TUNNEL_HEADERS, type Plan,
} from '../plan-client';

const step = (over: Record<string, unknown> = {}) => ({
  id: 'a', title: 'A', prompt: 'do a', maxTokens: 2048, dependsOn: [] as string[], ...over,
});
const plan = (over: Record<string, unknown> = {}): Plan =>
  ({ version: 1, goal: 'g', steps: [step()], ...over }) as Plan;

/** A Response whose body streams the given chunks, as fetch would. */
function sseResponse(chunks: string[], init: { ok?: boolean; status?: number; text?: string } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => init.text ?? '',
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined },
      }),
    },
  } as unknown as Response;
}

describe('canonicalize', () => {
  it('keeps only the fields the commitment covers', () => {
    const c = JSON.parse(canonicalize(plan({ steps: [step({ colour: 'red', notes: 'ignore me' })] })));
    expect(Object.keys(c)).toEqual(['version', 'goal', 'steps']);
    expect(Object.keys(c.steps[0])).toEqual(['id', 'title', 'prompt', 'maxTokens', 'dependsOn']);
  });

  it('sorts dependsOn, because dependency order is a set', () => {
    const one = canonicalize(plan({ steps: [step({ dependsOn: ['x', 'b', 'm'] })] }));
    const two = canonicalize(plan({ steps: [step({ dependsOn: ['m', 'x', 'b'] })] }));
    expect(one).toBe(two);
  });

  it('does not sort steps, because step order is not a set', () => {
    const one = canonicalize(plan({ steps: [step({ id: 'a' }), step({ id: 'b' })] }));
    const two = canonicalize(plan({ steps: [step({ id: 'b' }), step({ id: 'a' })] }));
    expect(one).not.toBe(two);
  });

  it('does not mutate the plan it was handed', () => {
    // The sort is on a copy. Sorting in place would reorder the array the UI is
    // rendering from, under the guest, between display and commit.
    const p = plan({ steps: [step({ dependsOn: ['z', 'a'] })] });
    canonicalize(p);
    expect(p.steps[0].dependsOn).toEqual(['z', 'a']);
  });

  it('separates plans that differ in a prompt', () => {
    expect(canonicalize(plan())).not.toBe(canonicalize(plan({ steps: [step({ prompt: 'do b' })] })));
  });

  it('separates plans that differ in a token ceiling', () => {
    expect(canonicalize(plan())).not.toBe(canonicalize(plan({ steps: [step({ maxTokens: 4096 })] })));
  });

  it('separates plans that differ in the goal', () => {
    expect(canonicalize(plan())).not.toBe(canonicalize(plan({ goal: 'other' })));
  });
});

describe('planHash', () => {
  it('is keccak256 of the canonical form, and nothing else', () => {
    const p = plan();
    expect(planHash(p)).toBe(keccak256(stringToHex(canonicalize(p))));
  });

  it('is stable across two equal plans built separately', () => {
    expect(planHash(plan())).toBe(planHash(plan()));
  });

  it('changes when a prompt changes', () => {
    expect(planHash(plan())).not.toBe(planHash(plan({ steps: [step({ prompt: 'other' })] })));
  });
});

describe('planMaxTokens', () => {
  it('sums the per-step ceilings as a bigint', () => {
    expect(planMaxTokens(plan({ steps: [step({ maxTokens: 2048 }), step({ maxTokens: 4096 })] }))).toBe(6144n);
  });

  it('is zero for a plan with no steps', () => {
    expect(planMaxTokens(plan({ steps: [] }))).toBe(0n);
  });
});

describe('waves', () => {
  it('puts independent steps in one wave', () => {
    expect(waves(plan({ steps: [step({ id: 'a' }), step({ id: 'b' })] }))).toEqual([['a', 'b']]);
  });

  it('orders a dependency into a later wave', () => {
    const p = plan({ steps: [step({ id: 'a' }), step({ id: 'b', dependsOn: ['a'] })] });
    expect(waves(p)).toEqual([['a'], ['b']]);
  });

  it('waits for every dependency, not just the first', () => {
    const p = plan({ steps: [
      step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c', dependsOn: ['a', 'b'] }),
    ] });
    expect(waves(p)).toEqual([['a', 'b'], ['c']]);
  });

  it('stops rather than looping forever on a cycle', () => {
    // The node's validator rejects cycles, so this only has to terminate.
    const p = plan({ steps: [step({ id: 'a', dependsOn: ['b'] }), step({ id: 'b', dependsOn: ['a'] })] });
    expect(waves(p)).toEqual([]);
  });

  it('omits a step whose dependency is not in the plan', () => {
    const p = plan({ steps: [step({ id: 'a', dependsOn: ['ghost'] })] });
    expect(waves(p)).toEqual([]);
  });
});

describe('readStream', () => {
  const frames = () => {
    const seen: unknown[] = [];
    return { seen, onFrame: (f: unknown) => seen.push(f) };
  };

  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('parses one frame per data line', async () => {
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      sseResponse(['data: {"a":1}\ndata: {"a":2}\ndata: [DONE]\n']),
    );
    const f = frames();
    await readStream('http://n/plan', {}, f.onFrame);
    expect(f.seen).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('buffers a frame split across two chunks', async () => {
    // The case the newline buffering exists for. Without it the half-line is
    // parsed as JSON, fails, and the frame is lost.
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      sseResponse(['data: {"a":', '1}\n', 'data: [DONE]\n']),
    );
    const f = frames();
    await readStream('http://n/plan', {}, f.onFrame);
    expect(f.seen).toEqual([{ a: 1 }]);
  });

  it('skips a torn frame rather than throwing away the answer', async () => {
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      sseResponse(['data: {broken\ndata: {"a":2}\ndata: [DONE]\n']),
    );
    const f = frames();
    await readStream('http://n/plan', {}, f.onFrame);
    expect(f.seen).toEqual([{ a: 2 }]);
  });

  it('ignores heartbeats and any line that is not a data frame', async () => {
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      sseResponse([': hb\n\ndata: {"a":1}\nevent: ping\ndata: [DONE]\n']),
    );
    const f = frames();
    await readStream('http://n/plan', {}, f.onFrame);
    expect(f.seen).toEqual([{ a: 1 }]);
  });

  it('stops at [DONE] and ignores anything after it', async () => {
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      sseResponse(['data: {"a":1}\ndata: [DONE]\ndata: {"a":99}\n']),
    );
    const f = frames();
    await readStream('http://n/plan', {}, f.onFrame);
    expect(f.seen).toEqual([{ a: 1 }]);
  });

  it('returns cleanly when the body ends without [DONE]', async () => {
    // A node that dies mid-stream ends the body. That is the failover trigger,
    // and it must not be reported as a parse error.
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(sseResponse(['data: {"a":1}\n']));
    const f = frames();
    await expect(readStream('http://n/plan', {}, f.onFrame)).resolves.toBeUndefined();
    expect(f.seen).toEqual([{ a: 1 }]);
  });

  it('accepts a trailing [DONE] with no newline after it', async () => {
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(sseResponse(['data: [DONE]']));
    const f = frames();
    await expect(readStream('http://n/plan', {}, f.onFrame)).resolves.toBeUndefined();
  });

  it('throws with the status and body when the node refuses', async () => {
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      sseResponse([], { ok: false, status: 402, text: 'job not open' }),
    );
    await expect(readStream('http://n/plan', {}, () => {})).rejects.toThrow(/402/);
  });

  it('sends the tunnel headers and a JSON body', async () => {
    const fetchMock = fetch as never as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(sseResponse(['data: [DONE]\n']));
    await readStream('http://n/plan', { jobId: '12' }, () => {});
    const [, init] = fetchMock.mock.calls[0] as [string, Record<string, never>];
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject(TUNNEL_HEADERS);
    expect(init.body).toBe(JSON.stringify({ jobId: '12' }));
  });
});

describe('requestPlan', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns the plan frame and streams the reasoning to onProgress', async () => {
    const result = { plan: plan(), planHash: '0x1', costWei: '1', summary: 's', attempts: 1 };
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(sseResponse([
      `data: {"th":"thinking"}\ndata: {"t":"tok"}\ndata: ${JSON.stringify(result)}\ndata: [DONE]\n`,
    ]));
    const progress: unknown[] = [];
    const r = await requestPlan('http://n', 12n, 'a goal', f => progress.push(f));
    expect(r.summary).toBe('s');
    // Reasoning and raw output are both billed, which is why they are shown.
    expect(progress).toEqual([{ th: 'thinking' }, { t: 'tok' }]);
  });

  it('raises the node error with its issues attached', async () => {
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(sseResponse([
      'data: {"err":"planner failed","issues":[{"code":"too_many_steps","message":"cap is 12"}]}\ndata: [DONE]\n',
    ]));
    await expect(requestPlan('http://n', 12n, 'g', () => {})).rejects.toThrow(/planner failed.*cap is 12/);
  });

  it('raises a clear error when the stream ends with no plan at all', async () => {
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(sseResponse(['data: [DONE]\n']));
    await expect(requestPlan('http://n', 12n, 'g', () => {})).rejects.toThrow(/without a plan/);
  });

  it('posts the job id as a string, because JSON has no bigint', async () => {
    const fetchMock = fetch as never as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(sseResponse([`data: ${JSON.stringify({ plan: plan() })}\ndata: [DONE]\n`]));
    await requestPlan('http://n', 12n, 'g', () => {});
    const [url, init] = fetchMock.mock.calls[0] as [string, Record<string, string>];
    expect(url).toBe('http://n/plan');
    expect(JSON.parse(init.body)).toEqual({ jobId: '12', goal: 'g' });
  });
});

describe('runPlan', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('forwards every executor event', async () => {
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(sseResponse([
      'data: {"kind":"wave","n":1,"steps":["a"]}\ndata: {"kind":"token","id":"a","t":"x"}\ndata: [DONE]\n',
    ]));
    const seen: unknown[] = [];
    await runPlan('http://n', 12n, plan(), e => seen.push(e));
    expect(seen).toEqual([
      { kind: 'wave', n: 1, steps: ['a'] },
      { kind: 'token', id: 'a', t: 'x' },
    ]);
  });

  it('surfaces a mid-stream error as a step_failed rather than dropping it', async () => {
    (fetch as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      sseResponse(['data: {"err":"node died"}\ndata: [DONE]\n']),
    );
    const seen: unknown[] = [];
    await runPlan('http://n', 12n, plan(), e => seen.push(e));
    expect(seen).toEqual([{ kind: 'step_failed', id: '', code: 'stream', message: 'node died' }]);
  });

  it('posts to /plan/run with the plan and the job id', async () => {
    const fetchMock = fetch as never as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(sseResponse(['data: [DONE]\n']));
    const p = plan();
    await runPlan('http://n', 7n, p, () => {});
    const [url, init] = fetchMock.mock.calls[0] as [string, Record<string, string>];
    expect(url).toBe('http://n/plan/run');
    expect(JSON.parse(init.body)).toEqual({ jobId: '7', plan: p });
  });
});
