/**
 * The matcher, against the id shapes the runtimes in src/runtimes.ts really
 * return, and against the fine-tunes it must refuse.
 *
 * Two halves, and the second matters more than the first. Matching the same
 * weights across five spellings is the feature; refusing to match a fine-tune,
 * a base build or a different size to a price band is what makes the feature
 * safe to put in front of money.
 */
import { describe, it, expect } from 'vitest';
import { canonical, matchModel, collisions } from '../model-id.js';
import { MARKET_ID } from '../pricing.js';

const TAGS = Object.keys(MARKET_ID);

describe('canonical', () => {
  it('reduces the five spellings of one model to one string', () => {
    // Exactly the ids observed from ollama, LM Studio, KoboldCpp, llama.cpp
    // and a HuggingFace GGUF repo, for the same weights at the same price.
    const same = [
      'qwen3:8b',
      'qwen/qwen3-8b',
      'koboldcpp/Qwen3-8B-Q4_K_M.gguf',
      'qwen3-8b-q4_k_m.gguf',
      'lmstudio-community/Qwen3-8B-GGUF',
      'Qwen3-8B-Instruct',
      'qwen3_8b',
    ];
    expect(new Set(same.map(canonical)).size).toBe(1);
    expect(canonical(same[0])).toBe('qwen3-8b');
  });

  it('keeps the dot, because the version lives in it', () => {
    // Flattening this would merge llama3.2 into llama3, which are different
    // weights at different prices.
    expect(canonical('llama3.2:1b')).toBe('llama3.2-1b');
    expect(canonical('meta-llama/Llama-3.2-1B-Instruct')).toBe('llama3.2-1b');
    expect(canonical('llama3.2:1b')).not.toBe(canonical('llama3:1b'));
  });

  it('flattens the separator between a name and a number, on both sides', () => {
    // ollama omits it and everyone else writes it. Safe only because the
    // market table's own keys go through this same function.
    expect(canonical('mistral:7b')).toBe(canonical('Mistral-7B-Instruct-v0.3'.replace('-v0.3', '')));
    expect(canonical('gemma3:4b')).toBe(canonical('google/gemma-3-4b-it'));
  });

  it('strips quantization, format and file extension, in any combination', () => {
    for (const q of ['q4_k_m', 'Q8_0', 'iq4_xs', 'f16', 'bf16', 'mxfp4', 'awq', 'int4', '4bit', 'mlx']) {
      expect(canonical(`qwen3-8b-${q}`)).toBe('qwen3-8b');
    }
    // Two decorations in a row, which one pass would leave half done.
    expect(canonical('Qwen3-8B-Q4_K_M-GGUF.gguf')).toBe('qwen3-8b');
    expect(canonical('qwen3-8b-instruct-q4_k_m.gguf')).toBe('qwen3-8b');
  });

  it('is empty for an empty id rather than throwing', () => {
    expect(canonical('')).toBe('');
    expect(canonical(undefined as any)).toBe('');
    expect(canonical('   ')).toBe('');
  });
});

describe('matchModel', () => {
  it('takes an ollama tag through the exact path, unchanged', () => {
    // An operator on ollama must not acquire a new code path from any of this.
    const m = matchModel('qwen3:8b', TAGS);
    expect(m).toMatchObject({ tag: 'qwen3:8b', how: 'exact' });
  });

  it('prices every runtime spelling against the same band', () => {
    for (const id of [
      'qwen/qwen3-8b',
      'koboldcpp/Qwen3-8B-Q4_K_M.gguf',
      'qwen3-8b-q4_k_m.gguf',
      'lmstudio-community/Qwen3-8B-GGUF',
    ]) {
      expect(matchModel(id, TAGS)).toMatchObject({ tag: 'qwen3:8b', how: 'derived' });
    }
  });

  it('lets a hand-written alias beat the parse', () => {
    // A hand verification is a claim someone checked; the parse is a rule.
    const m = matchModel('weird-vendor-name', TAGS, { 'weird-vendor-name': 'qwen3:14b' });
    expect(m).toMatchObject({ tag: 'qwen3:14b', how: 'alias' });
  });

  it('ignores an alias pointing at a model the table does not price', () => {
    expect(matchModel('x', TAGS, { x: 'not-in-the-table' }).tag).toBe(null);
  });

  describe('refuses to match, which is the point', () => {
    it('a fine-tune of a priced model', () => {
      // Different weights. Selling them at the base model's price is the
      // failure this file is arranged around.
      for (const id of ['qwen3-8b-abliterated', 'Qwen3-8B-uncensored-GGUF', 'qwen3-8b-my-lora-v2']) {
        expect(matchModel(id, TAGS)).toMatchObject({ tag: null, how: 'none' });
      }
    });

    it('a base build, where the instruct band would be the wrong one', () => {
      expect(matchModel('Qwen3-8B-Base', TAGS).tag).toBe(null);
      expect(matchModel('qwen3-8b-pt', TAGS).tag).toBe(null);
    });

    it('a different size of the same family', () => {
      expect(matchModel('qwen3-4b', TAGS).tag).toBe(null);
      expect(matchModel('qwen3-32b', TAGS).tag).toBe(null);
    });

    it('a model that merely starts with or contains a priced one', () => {
      // Equality, never proximity.
      expect(matchModel('qwen3-8b-plus', TAGS).tag).toBe(null);
      expect(matchModel('my-qwen3-8b', TAGS).tag).toBe(null);
    });

    it('a version that is not the one priced', () => {
      expect(matchModel('mistral-7b-instruct-v0.3', TAGS).tag).toBe(null);
      expect(matchModel('llama3.1:8b', TAGS).tag).toBe(null);
    });

    it('an empty or nonsense id', () => {
      expect(matchModel('', TAGS)).toMatchObject({ tag: null, how: 'none' });
      expect(matchModel('   ', TAGS).tag).toBe(null);
      expect(matchModel('gguf', TAGS).tag).toBe(null);
    });
  });

  it('reports what it reduced to, so an unmatched model can be read', () => {
    expect(matchModel('koboldcpp/Qwen3-8B-Abliterated-Q4_K_M.gguf', TAGS).canonical)
      .toBe('qwen3-8b-abliterated');
  });
});

describe('the market table', () => {
  it('has no two models that canonicalise to one string', () => {
    // The guard on everything above. A collision here means the parse would
    // pick whichever key came first and quote one model's price for another
    // model's weights, silently, to someone paying.
    expect(collisions(TAGS)).toEqual([]);
  });

  it('matches every one of its own keys back to itself', () => {
    for (const tag of TAGS) {
      expect(matchModel(tag, TAGS)).toMatchObject({ tag, how: 'exact' });
      // And through the derived path too, with the exact route removed, since
      // that is the route a non-ollama runtime will take to the same model.
      const others = TAGS.filter(t => t !== tag);
      expect(matchModel(canonical(tag), [...others, tag])).toMatchObject({ tag, how: 'derived' });
    }
  });
});
