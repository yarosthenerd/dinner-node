import { describe, expect, it } from 'vitest';
import { CATALOG, fit, kvPerTokenFromInfo, recommend } from '../models.js';
import type { Hardware } from '../hardware.js';

const hw = (budgetMB: number): Hardware => ({
  platform: 'linux', arch: 'x64', cores: 8, cpu: 'test', ramMB: 32768,
  gpus: [], budgetMB, budgetSource: 'test', unified: false,
});

describe('fit', () => {
  // qwen3:8b as published: 4987 MiB of weights, 147456 bytes of KV per token.
  // At 32768 tokens the KV cache is 4608 MiB, which is as large as the weights.
  // Sizing on weights alone is what puts half a model on the CPU.
  it('counts the KV cache, not just the weights', () => {
    const f = fit(4987, 147456, 32768, 11004);
    expect(f.needMB).toBe(4987 + 4608 + 600);
    expect(f.fits).toBe(true);
  });

  it('rejects the same model on an 8 GB card', () => {
    expect(fit(4987, 147456, 32768, 7372).fits).toBe(false);
  });

  it('reports the context that would fit, rounded to whole 1024s', () => {
    const f = fit(4987, 147456, 32768, 7372);
    expect(f.maxCtx % 1024).toBe(0);
    expect(fit(4987, 147456, f.maxCtx, 7372).fits).toBe(true);
    expect(fit(4987, 147456, f.maxCtx + 1024, 7372).fits).toBe(false);
  });

  it('reports no usable context when the weights alone do not fit', () => {
    expect(fit(17000, 147456, 32768, 11004).maxCtx).toBe(0);
  });

  it('never advertises more context than the weights were trained for', () => {
    expect(fit(1259, 32768, 32768, 200000, 8192).maxCtx).toBe(8192);
  });
});

describe('recommend', () => {
  it('picks the strongest model that fits whole, not the first one', () => {
    expect(recommend(hw(11004), 32768).pick.tag).toBe('qwen3:8b');
    expect(recommend(hw(16384), 32768).pick.tag).toBe('qwen3:14b');
  });

  it('uses a 32 GB card rather than capping at 14B', () => {
    // Budgets here are what probeHardware would report, which is 90% of VRAM
    // on a discrete card, not the card's nameplate size.
    expect(recommend(hw(Math.floor(32768 * 0.9)), 16384).pick.tag).toBe('qwen3.6:35b-a3b');
  });

  it('leaves a 24 GB card on 14B, because the MoE does not fit it', () => {
    // 21,573 MiB of weights against a 22,118 MiB budget. Recording this as a
    // test rather than a comment because it is the kind of thing a later
    // catalog entry could silently break.
    expect(recommend(hw(Math.floor(24576 * 0.9)), 16384).pick.tag).toBe('qwen3:14b');
  });

  it('still picks 14B on a 16 GB card', () => {
    // Guard on the row above: adding a bigger entry must not drag a smaller
    // card up to a model it cannot hold.
    expect(recommend(hw(Math.floor(16384 * 0.9)), 16384).pick.tag).toBe('qwen3:14b');
  });

  it('falls back to the smallest when nothing fits', () => {
    const r = recommend(hw(2048), 32768);
    expect(r.pick.tag).toBe(CATALOG[0].tag);
    expect(r.fitsWhole).toBe(false);
  });

  it('every pick it calls a fit really does fit', () => {
    for (const budget of [4096, 6144, 8192, 12288, 16384, 24576]) {
      const r = recommend(hw(budget), 32768);
      if (r.fitsWhole) expect(r.fit.needMB).toBeLessThanOrEqual(budget);
    }
  });
});

describe('kvPerTokenFromInfo', () => {
  // Read from the live /api/show of qwen3.8:27b: 65 blocks, 4 KV heads,
  // 256-wide keys and values. 65 x 4 x 512 x 2 = 266240 bytes per token, which
  // is 8.1 GB of KV cache at a 32768 context.
  it('reads the geometry ollama publishes', () => {
    expect(kvPerTokenFromInfo({
      'qwen35.block_count': 65,
      'qwen35.attention.head_count_kv': 4,
      'qwen35.attention.key_length': 256,
      'qwen35.attention.value_length': 256,
    })).toBe(266240);
  });

  it('derives the head width when the architecture omits it', () => {
    expect(kvPerTokenFromInfo({
      'llama.block_count': 32,
      'llama.attention.head_count': 32,
      'llama.attention.head_count_kv': 8,
      'llama.embedding_length': 4096,
    })).toBe(32 * 8 * 256 * 2);
  });

  it('returns null rather than guessing', () => {
    expect(kvPerTokenFromInfo({ 'foo.block_count': 32 })).toBeNull();
  });
});
