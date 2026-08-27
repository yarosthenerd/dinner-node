// Pricing, without the network.
//
// Every function that decides a number is pure and tested here; the one
// function that reaches OpenRouter takes an injected fetch. A node's rate ends
// up on chain via registerProvider, so a defect in this file is a defect in
// what guests are charged, which is the reason none of it is left to a live
// call at test time.
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MON_USD, MARKET_ID, PINNED,
  breakEvenTokens, describeRate, fetchBand, pickTarget, resolveRate, usdPerMillion, weiPerMillion,
} from '../pricing.js';

const endpointsBody = (outs: number[]) => ({
  data: { endpoints: outs.map((o, i) => ({ provider_name: `p${i}`, pricing: { completion: String(o / 1e6), prompt: '0.0000001' } })) },
});
const okFetch = (body: unknown) => vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

describe('weiPerMillion', () => {
  it('converts a dollar rate at the assumed MON price', () => {
    // $1.006/M at $0.03/MON is 33.533... MON, which is what the node has been
    // registering by hand.
    const wei = weiPerMillion(1.006, 0.03);
    expect(Number(wei) / 1e18).toBeCloseTo(33.533, 3);
  });

  it('round-trips back to the dollar figure', () => {
    expect(usdPerMillion(weiPerMillion(0.9, 0.03), 0.03)).toBeCloseTo(0.9, 6);
  });

  it('refuses nonsense rather than returning a garbage rate', () => {
    expect(weiPerMillion(0, 0.03)).toBe(0n);
    expect(weiPerMillion(1, 0)).toBe(0n);
    expect(weiPerMillion(-1, 0.03)).toBe(0n);
  });

  it('keeps whole wei, not a float approximation', () => {
    // The registered rate and the published rate have to be the same number.
    expect(typeof weiPerMillion(1.114, DEFAULT_MON_USD)).toBe('bigint');
    expect(weiPerMillion(1.114, 0.03) % 10n ** 12n).toBe(0n);
  });
});

describe('pickTarget', () => {
  const band = { min: 0.7, median: 1.114, max: 1.6, providers: 10, measured: 'x' };

  it('reads each position off the band', () => {
    expect(pickTarget(band, 'min', 1)).toBeCloseTo(0.7);
    expect(pickTarget(band, 'median', 1)).toBeCloseTo(1.114);
    expect(pickTarget(band, 'max', 1)).toBeCloseTo(1.6);
  });

  it('applies the discount to the chosen position', () => {
    expect(pickTarget(band, 'median', 0.9)).toBeCloseTo(1.0026);
  });
});

describe('breakEvenTokens', () => {
  it('says how many tokens one settle has to be worth', () => {
    // 100,915 gas at 102 gwei against the rate this node registers today.
    const n = breakEvenTokens(100915n, 102_000_000_000n, weiPerMillion(1.006, 0.03));
    expect(n).toBeGreaterThan(250);
    expect(n).toBeLessThan(400);
  });

  it('rises as the price falls, which is the whole risk of undercutting', () => {
    const dear = breakEvenTokens(100915n, 102_000_000_000n, weiPerMillion(1.006, 0.03));
    const cheap = breakEvenTokens(100915n, 102_000_000_000n, weiPerMillion(0.2, 0.03));
    expect(cheap).toBeGreaterThan(dear * 4);
  });

  it('is infinite at a zero rate rather than dividing by it', () => {
    expect(breakEvenTokens(100915n, 102_000_000_000n, 0n)).toBe(Infinity);
  });
});

describe('fetchBand', () => {
  it('builds a band from the endpoint list', async () => {
    const b = await fetchBand('qwen/x', okFetch(endpointsBody([1.0, 0.7, 1.6, 0.9])));
    expect(b).toEqual(expect.objectContaining({ min: 0.7, max: 1.6, providers: 4 }));
    expect(b!.median).toBe(1.0);
  });

  it('returns null on a bad response instead of throwing', async () => {
    const bad = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchBand('qwen/x', bad)).toBeNull();
  });

  it('returns null when the network fails, so a node still starts', async () => {
    const boom = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await fetchBand('qwen/x', boom)).toBeNull();
  });

  it('ignores endpoints with no usable completion price', async () => {
    const b = await fetchBand('qwen/x', okFetch({ data: { endpoints: [
      { pricing: { completion: '0' } }, { pricing: {} }, { pricing: { completion: '0.0000009' } },
    ] } }));
    expect(b!.providers).toBe(1);
    expect(b!.min).toBeCloseTo(0.9);
  });
});

describe('resolveRate', () => {
  it('prices the served model from its own live band', async () => {
    const r = await resolveRate({
      model: 'qwen3.6:35b-a3b', policy: 'median',
      fetchImpl: okFetch(endpointsBody([0.7, 0.9, 1.114, 1.6])),
    });
    expect(r.source).toBe('live');
    expect(r.orId).toBe('qwen/qwen3.6-35b-a3b');
    expect(r.usdPerMillion).toBeCloseTo(1.114);
  });

  it('falls back to the pinned band when OpenRouter is unreachable', async () => {
    const boom = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const r = await resolveRate({ model: 'qwen3.6:35b-a3b', fetchImpl: boom });
    expect(r.source).toBe('pinned');
    expect(r.usdPerMillion).toBeCloseTo(PINNED['qwen/qwen3.6-35b-a3b'].median);
    expect(r.ratePerMillionWei).toBeGreaterThan(0n);
  });

  it('lets an explicit operator override win over the market', async () => {
    const r = await resolveRate({ model: 'qwen3.6:35b-a3b', overrideWei: 12345n * 10n ** 12n });
    expect(r.source).toBe('override');
    expect(r.ratePerMillionWei).toBe(12345n * 10n ** 12n);
  });

  it('invents no rate for a model it has no market for', async () => {
    const r = await resolveRate({ model: 'some:unknown-model' });
    expect(r.source).toBe('none');
    expect(r.ratePerMillionWei).toBe(0n);
    expect(r.orId).toBeNull();
  });

  it('prices a small model far below a large one', async () => {
    const boom = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const small = await resolveRate({ model: 'llama3.2:1b', fetchImpl: boom });
    const big = await resolveRate({ model: 'qwen3.6:35b-a3b', fetchImpl: boom });
    // The defect this feature exists to fix: one constant billed both alike.
    expect(small.ratePerMillionWei).toBeLessThan(big.ratePerMillionWei);
  });

  it('every catalog id it maps has a pinned band to fall back to', () => {
    for (const orId of Object.values(MARKET_ID)) {
      expect(PINNED[orId], `${orId} has no pinned band`).toBeDefined();
    }
  });
});

describe('describeRate', () => {
  it('states the position in the band, not just the price', async () => {
    const boom = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const r = await resolveRate({ model: 'qwen3.6:35b-a3b', policy: 'median', discount: 0.9, fetchImpl: boom });
    const s = describeRate(r);
    expect(s).toContain('below the median');
    expect(s).toContain('10 provider');
    expect(s).toContain('[pinned]');
  });
});
