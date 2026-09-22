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
  breakEvenTokens, cheaperThanCount, crossoverRatio, describeFreeInput, describeRate,
  fetchBand, pickTarget, resolveRate, rivalEffective, usdPerMillion, weiPerMillion,
} from '../pricing.js';

const endpointsBody = (outs: number[]) => ({
  data: { endpoints: outs.map((o, i) => ({ provider_name: `p${i}`, pricing: { completion: String(o / 1e6), prompt: '0.0000001' } })) },
});
const DB = { name: 'Darkbloom', inUsd: 0.070, outUsd: 0.700 };
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


// The comparison the output column hides. Every provider on this listing bills
// input; settle() only ever counts tokens this node generated, so our input
// price is zero and a bare output-to-output comparison flatters them.
describe('free input', () => {
  it('prices a rival at what the job actually costs, not at its output column', () => {
    expect(rivalEffective(DB, 0)).toBeCloseTo(0.700);
    // A prompt four times the length of the answer costs 4 x the input rate
    // per output token on top.
    expect(rivalEffective(DB, 4)).toBeCloseTo(0.980);
    expect(rivalEffective(DB, 10)).toBeCloseTo(1.400);
  });

  it('says at what workload shape we become cheaper than the cheapest rival', () => {
    // ($1.002 - $0.700) / $0.070 per input token.
    expect(crossoverRatio(DB, 1.002)).toBeCloseTo(4.31, 1);
  });

  it('is zero against a rival we already undercut on output', () => {
    expect(crossoverRatio({ name: 'x', inUsd: 0.2, outUsd: 1.6 }, 1.002)).toBe(0);
  });

  it('is never against a rival that is cheaper on output and free on input', () => {
    expect(crossoverRatio({ name: 'free', inUsd: 0, outUsd: 0.5 }, 1.002)).toBe(Infinity);
  });

  it('counts more of the listing undercut as prompts get longer', () => {
    // Deliberately free of literal market numbers. This assertion used to say
    // "at five to one we are cheapest of all ten", which was true when it was
    // written and stopped being true the day Darkbloom cut its input price
    // from $0.070 to $0.050 and pushed the crossover from 4.3x to 6.0x. The
    // property is monotonicity plus a crossover the band itself defines; the
    // exact ratio is the market's business, not the test's.
    const band = PINNED['qwen/qwen3.6-35b-a3b'];
    const ours = 1.002;
    expect(cheaperThanCount(band, ours, 0)).toBeLessThan(cheaperThanCount(band, ours, 1));
    expect(cheaperThanCount(band, ours, 1)).toBeLessThan(cheaperThanCount(band, ours, 5));
    // Past the worst crossover in the band, free input beats every listing.
    const worst = Math.max(...band.endpoints!.map(e => crossoverRatio(e, ours)));
    expect(Number.isFinite(worst)).toBe(true);
    expect(cheaperThanCount(band, ours, worst + 0.01)).toBe(band.endpoints!.length);
  });

  it('keeps the input price when reading a live listing', async () => {
    const b = await fetchBand('qwen/x', okFetch({ data: { endpoints: [
      { provider_name: 'A', pricing: { completion: '0.0000007', prompt: '0.00000007' } },
    ] } }));
    expect(b!.endpoints![0]).toEqual({ name: 'A', inUsd: 0.07, outUsd: 0.7 });
  });

  it('treats a missing input price as free rather than as NaN', async () => {
    const b = await fetchBand('qwen/x', okFetch({ data: { endpoints: [
      { provider_name: 'A', pricing: { completion: '0.0000007' } },
    ] } }));
    expect(b!.endpoints![0].inUsd).toBe(0);
  });

  it('describes the advantage with the number that backs it', async () => {
    const boom = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const r = await resolveRate({ model: 'qwen3.6:35b-a3b', policy: 'median', discount: 0.9, fetchImpl: boom });
    const line = describeFreeInput(r)!;
    const cheapest = r.band!.endpoints![0];
    expect(line).toContain(cheapest.name);
    // The ratio is read back out of the band rather than pinned to a literal,
    // for the same reason as the test above: it moves whenever a rival
    // repriced. What must hold is that the sentence quotes the number the
    // arithmetic actually produces.
    const x = crossoverRatio(cheapest, r.usdPerMillion);
    expect(line).toContain(`once a prompt is ${x.toFixed(1)}x the answer`);
  });

  it('says nothing when the band carries no endpoint detail', () => {
    // Built here rather than borrowed from PINNED. It used to read qwen3:8b,
    // whose pinned band happened to have no endpoints; refreshing the table
    // gave it some and the test started asserting the opposite of its name.
    // A test for "no endpoints" should construct a band with no endpoints.
    const bandless = {
      ratePerMillionWei: 0n, usdPerMillion: 1,
      band: { min: 1, median: 1, max: 1, providers: 1, measured: '2026-08-27' },
      source: 'pinned', orId: 'qwen/x', matchedTag: 'x', match: 'exact' as const,
      policy: 'median' as const, discount: 0.9,
    };
    expect(describeFreeInput(bandless)).toBeNull();
    expect(describeFreeInput({ ...bandless, band: null })).toBeNull();
  });
});

describe('resolveRate across runtimes', () => {
  // No network: the pinned band is the floor of information this is meant to
  // reach, and reaching it from a foreign model id is the whole point.
  const offline = (async () => { throw new Error('offline'); }) as any;

  it('prices a KoboldCpp gguf filename against the model it actually is', () => {
    // Before this, every non-ollama node fell through to the built-in default
    // rate, because nobody spells a model the way ollama does.
    return Promise.all([
      'qwen3:8b',
      'qwen/qwen3-8b',
      'koboldcpp/Qwen3-8B-Q4_K_M.gguf',
      'qwen3-8b-q4_k_m.gguf',
    ].map(async model => {
      const r = await resolveRate({ model, fetchImpl: offline });
      expect(r.orId).toBe('qwen/qwen3-8b');
      expect(r.ratePerMillionWei).toBeGreaterThan(0n);
      expect(r.matchedTag).toBe('qwen3:8b');
    }));
  });

  it('leaves an ollama node on the exact path, with no new behaviour', async () => {
    const r = await resolveRate({ model: 'qwen3:8b', fetchImpl: offline });
    expect(r.match).toBe('exact');
    expect(describeRate(r)).not.toContain('priced as');
  });

  it('says out loud when a price was derived from a parsed id', async () => {
    // The disclosure that makes the derived path safe to run: an operator who
    // disagrees can see the claim in the log line rather than infer it.
    const r = await resolveRate({ model: 'koboldcpp/Qwen3-8B-Q4_K_M.gguf', fetchImpl: offline });
    expect(r.match).toBe('derived');
    expect(describeRate(r)).toContain('priced as qwen3:8b [derived]');
  });

  it('still refuses a fine-tune, and charges nothing rather than the wrong thing', async () => {
    const r = await resolveRate({ model: 'qwen3-8b-abliterated', fetchImpl: offline });
    expect(r.ratePerMillionWei).toBe(0n);
    expect(r.source).toBe('none');
    expect(r.matchedTag).toBe(null);
    // Which leaves host.ts on whatever default it had, as it was before.
  });

  it('carries the match through an operator override, without using it to price', async () => {
    // An override is the operator speaking and nothing here argues with it.
    // The band still comes back, because it is what the log line compares to.
    const r = await resolveRate({
      model: 'qwen3-8b-q4_k_m.gguf', overrideWei: 42n, fetchImpl: offline,
    });
    expect(r.ratePerMillionWei).toBe(42n);
    expect(r.source).toBe('override');
    expect(r.matchedTag).toBe('qwen3:8b');
    expect(r.band).not.toBe(null);
  });
});
