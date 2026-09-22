// The earnings model, and the guarantee that the hosting page agrees with it.
//
// The page is static and its data is generated, which is exactly the setup
// where a number quietly stops matching its source. These tests fail if the
// generated block drifts from src/models.ts and src/pricing.ts, or if the
// page's arithmetic drifts from src/earnings.ts.
import { describe, expect, it } from 'vitest';
import { MEASURED, REFERENCE_BANDWIDTH_MIB_S, estimate, gasShareOfGross, priceFor, recommendForVram } from '../earnings';
import { CATALOG } from '../models';
import { MARKET_ID, PINNED } from '../pricing';
// @ts-expect-error -- plain JS, no types, deliberately: it ships to a static page.
import * as page from '../../web/public/hosting-calc.js';
import { buildData } from '../../scripts/gen-hosting-calc';

const base = {
  hoursPerDay: 12, utilisation: 0.05, ctx: 16384,
  watts: 65, usdPerKwh: 0.15, monUsd: 0.03,
};

describe('the measured table', () => {
  it('derives bandwidth only from models that actually fit', () => {
    // The spilled rows must never touch the constant everything is scaled
    // from. This is the bug that produced a 2.3x error the first time.
    const clean = MEASURED.filter(m => m.onGpuPercent >= 100);
    expect(clean).toHaveLength(2);
    for (const m of clean) {
      const product = m.tokensPerSecond * m.weightsMB;
      // Each measured point is within 10% of the average, which is the
      // evidence that decoding is bandwidth-bound.
      expect(Math.abs(product - REFERENCE_BANDWIDTH_MIB_S) / REFERENCE_BANDWIDTH_MIB_S).toBeLessThan(0.1);
    }
  });

  it('keeps the spilled rows, because they are the warning', () => {
    const dense = MEASURED.find(m => m.model === 'qwen3.8:27b')!;
    const moe = MEASURED.find(m => m.model === 'qwen3.6:35b-a3b')!;
    expect(dense.onGpuPercent).toBeLessThan(90);
    expect(moe.onGpuPercent).toBeLessThan(90);
    // The 9x gap on identical hardware is why spill is never extrapolated.
    expect(moe.tokensPerSecond / dense.tokensPerSecond).toBeGreaterThan(5);
  });
});

describe('pricing a recommendation', () => {
  it('quotes nothing for a model with no market listing', () => {
    // Three small models genuinely have no OpenRouter listing. Quoting an
    // income for them would be inventing a number.
    for (const tag of ['qwen3:1.7b', 'qwen2.5:3b', 'qwen3:4b']) {
      expect(priceFor(tag)).toBeNull();
      const e = estimate({ ...base, vramMB: 8192 });
      if (e.pick.tag === tag) {
        expect(e.usdPerMillion).toBe(0);
        expect(e.grossUsdPerMonth).toBe(0);
      }
    }
  });

  it('prices every model that does have one at 90% of the median', () => {
    for (const c of CATALOG) {
      const orId = MARKET_ID[c.tag];
      if (!orId || !PINNED[orId]) continue;
      expect(priceFor(c.tag)!.usdPerMillion).toBeCloseTo(PINNED[orId].median * 0.9, 10);
    }
  });
});

describe('throughput is labelled by how much we know', () => {
  it('reports a measurement as measured', () => {
    const e = estimate({ ...base, vramMB: 12288 });
    expect(e.pick.tag).toBe('qwen3:8b');
    expect(e.tokensPerSecondSource).toBe('measured');
    expect(e.tokensPerSecond).toBe(49.5);
  });

  it('never extrapolates a model that does not fit', () => {
    // A 4 GB card cannot hold the smallest catalog entry at this context.
    const e = estimate({ ...base, vramMB: 2048 });
    expect(e.fitsWhole).toBe(false);
    expect(['spilled-floor', 'unknown']).toContain(e.tokensPerSecondSource);
  });

  it('scales an MoE from ACTIVE weights, not resident ones', () => {
    const e = estimate({ ...base, vramMB: 32768 });
    expect(e.pick.tag).toBe('qwen3.6:35b-a3b');
    expect(e.tokensPerSecondSource).toBe('scaled-moe');
    // Using the 21,573 MiB resident figure would predict about 12 tok/s, which
    // is slower than the same model measured while SPILLING. That absurdity is
    // what activeMB exists to prevent.
    const spilled = MEASURED.find(m => m.model === 'qwen3.6:35b-a3b')!.tokensPerSecond;
    expect(e.tokensPerSecond).toBeGreaterThan(spilled);
  });

  it('prefers the operator own measurement over any formula', () => {
    const e = estimate({ ...base, vramMB: 12288, tokensPerSecond: 77 });
    expect(e.tokensPerSecondSource).toBe('given');
    expect(e.tokensPerSecond).toBe(77);
  });
});

describe('the money', () => {
  it('scales linearly with utilisation, which is the whole point', () => {
    const a = estimate({ ...base, vramMB: 12288, utilisation: 0.05 });
    const b = estimate({ ...base, vramMB: 12288, utilisation: 0.10 });
    expect(b.grossUsdPerMonth).toBeCloseTo(a.grossUsdPerMonth * 2, 8);
  });

  it('takes gas as one tenth of gross, matching the settle policy', () => {
    const e = estimate({ ...base, vramMB: 12288, utilisation: 1 });
    expect(gasShareOfGross()).toBe(0.1);
    expect(e.gasUsdPerMonth).toBeCloseTo(e.grossUsdPerMonth * 0.1, 10);
  });

  it('charges electricity even when nothing is earned', () => {
    // An unpriced model still costs power. Net must be able to go negative,
    // because for some hardware it genuinely is.
    const e = estimate({ ...base, vramMB: 8192, utilisation: 1, hoursPerDay: 24 });
    if (e.usdPerMillion === 0) expect(e.netUsdPerMonth).toBeLessThan(0);
  });

  it('finds the case where more VRAM earns less', () => {
    // Recorded as a test because it is counterintuitive, it is the page's most
    // useful claim, and a price refresh could silently reverse it.
    const twelve = estimate({ ...base, vramMB: 12288, utilisation: 1, hoursPerDay: 24 });
    const sixteen = estimate({ ...base, vramMB: 16384, utilisation: 1, hoursPerDay: 24 });
    expect(twelve.pick.tag).toBe('qwen3:8b');
    expect(sixteen.pick.tag).toBe('qwen3:14b');
    expect(sixteen.netUsdPerMonth).toBeLessThan(twelve.netUsdPerMonth);
  });
});

describe('the hosting page cannot drift from the source', () => {
  it('ships the catalog that src/models.ts actually holds', () => {
    expect(page.DATA.catalog).toEqual(buildData().catalog);
  });

  it('ships the prices src/pricing.ts actually holds', () => {
    expect(page.DATA.prices).toEqual(buildData().prices);
    // And the generated block is current: regenerating changes nothing.
    expect(page.DATA.measured).toEqual(buildData().measured);
    expect(page.DATA.referenceBandwidthMiBs).toBe(REFERENCE_BANDWIDTH_MIB_S);
  });

  it('computes the same answer as src/earnings.ts across the whole grid', () => {
    for (const vramGB of [6, 8, 10, 12, 16, 20, 24, 32, 48]) {
      for (const ctx of [4096, 16384, 32768]) {
        for (const util of [0, 0.05, 1]) {
          const input = { ...base, vramMB: vramGB * 1024, ctx, utilisation: util };
          const ours = estimate(input);
          const theirs = page.estimate({ ...input, tokensPerSecond: 0, bandwidthMiBs: 0 });
          const where = `${vramGB}GB ctx${ctx} util${util}`;
          expect(theirs.pick.tag, where).toBe(ours.pick.tag);
          expect(theirs.fitsWhole, where).toBe(ours.fitsWhole);
          expect(theirs.tokensPerSecond, where).toBeCloseTo(ours.tokensPerSecond, 8);
          expect(theirs.tokensPerSecondSource, where).toBe(ours.tokensPerSecondSource);
          expect(theirs.usdPerMillion, where).toBeCloseTo(ours.usdPerMillion, 10);
          expect(theirs.netUsdPerMonth, where).toBeCloseTo(ours.netUsdPerMonth, 8);
        }
      }
    }
  });

  it('recommends identically, which is the part an operator acts on', () => {
    for (const vramGB of [6, 8, 12, 16, 24, 32, 48]) {
      const a = recommendForVram(vramGB * 1024, 16384);
      const b = page.recommendForVram(vramGB * 1024, 16384);
      expect(b.pick.tag).toBe(a.pick.tag);
      expect(b.budgetMB).toBe(a.budgetMB);
      expect(b.fit.maxCtx).toBe(a.fit.maxCtx);
    }
  });
});
