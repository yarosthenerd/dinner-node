/**
 * One model, named seven different ways, matched to one price.
 *
 * `pricing.ts` keys the market table by ollama tags and says, in a comment
 * above it, that the table is explicit rather than fuzzy because an entry that
 * is wrong prices a model against different weights. That was the right call
 * and it is still the right call. It also meant that the moment this node
 * learned to serve through anything other than ollama, every one of those
 * nodes fell through to the built-in default rate, because nobody names a
 * model the way ollama does:
 *
 *   ollama       qwen3:8b
 *   LM Studio    qwen/qwen3-8b
 *   KoboldCpp    koboldcpp/Qwen3-8B-Q4_K_M.gguf
 *   llama.cpp    qwen3-8b-q4_k_m.gguf
 *   HuggingFace  lmstudio-community/Qwen3-8B-GGUF
 *
 * Those are the same weights at the same market price, and pricing four of
 * them off a constant is not caution, it is a different way of being wrong.
 *
 * THE RULE THAT KEEPS THIS SAFE. Both sides are put through the same
 * canonical form, and a match is declared only when the two are EQUAL. There
 * is no closest match, no prefix match and no edit distance. Anything left
 * over that this file does not recognise as decoration means no match, and no
 * match means the caller prices as it did before rather than guessing.
 *
 * That is what stops `qwen3-8b-abliterated` being sold at the price of
 * `qwen3:8b`. It is a fine-tune, its leftover token is not recognised, and it
 * gets no band. The cost of that rule is a handful of real models that go
 * unpriced; the cost of the opposite rule is quoting one model's price for
 * another one's weights, on chain, to someone paying.
 */

/**
 * Ids that the parse below cannot reach, mapped by hand.
 *
 * Empty today, and kept because the first id that needs it should have one
 * obvious place to go rather than a special case grown into `canonical`.
 * Every entry here is a claim that two names are the same weights, so each one
 * wants the same hand verification the market table itself got.
 */
export const ALIASES: Record<string, string> = {};

/** Quantization and file-format decoration: `-q4_k_m`, `_iq4_xs`, `-f16`. */
const QUANT = /[-_.](i?q\d+(?:_[a-z0-9]+)*|f16|fp16|bf16|f32|fp32|mxfp\d+|awq|gptq|int4|int8|4bit|8bit|gguf|ggml|mlx)(?=[-_.]|$)/g;

/**
 * Instruction-tuned suffixes.
 *
 * Dropped rather than refused because ollama's tags ARE the instruct builds:
 * `qwen3:8b` is the instruct model, so matching `Qwen3-8B-Instruct` to it is
 * correct rather than approximate. The direction that would be wrong is
 * pricing a BASE model off the instruct band, and base builds label themselves
 * (`-base`, `-pt`), which this does not strip and therefore will not match.
 */
const VARIANT = /[-_.](instruct|it|chat)(?=[-_.]|$)/g;

const EXT = /\.(gguf|safetensors|bin|pt)$/;

/**
 * The shared form. Everything that identifies the weights survives; everything
 * that identifies the file does not.
 *
 * Dots are deliberately NOT treated as separators. `llama3.2` and `qwen3.6`
 * carry their version in the dot, and flattening it would merge model families
 * that are priced differently. What is flattened is the separator between a
 * name and a version number, so ollama's `mistral:7b` and HuggingFace's
 * `Mistral-7B` land on the same string. That is safe only because BOTH sides
 * go through this function, which is the property `noCollisions` in the tests
 * exists to hold.
 */
export function canonical(id: string): string {
  let s = String(id ?? '').trim().toLowerCase();
  // A publisher, an org or a repo path. `qwen/qwen3-8b` and
  // `koboldcpp/Qwen3-8B` name the same weights as the bare id does.
  s = s.slice(s.lastIndexOf('/') + 1);
  s = s.replace(EXT, '');
  // Repeated: `-q4_k_m-gguf` needs two passes, and a single global replace
  // leaves the second decoration behind once the first consumes its separator.
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(QUANT, '').replace(VARIANT, '');
    if (s === before) break;
  }
  s = s.replace(/[\s_:]+/g, '-');
  // The separator between a word and a version or size number, which ollama
  // omits and everyone else writes.
  s = s.replace(/([a-z])-+(\d)/g, '$1$2');
  return s.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

export type MatchHow = 'exact' | 'alias' | 'derived' | 'none';

export type Match = {
  /** The market table key this belongs to, or null when nothing matched. */
  tag: string | null;
  how: MatchHow;
  /** What the id reduced to, so an unmatched model can be read at a glance. */
  canonical: string;
};

/**
 * Match a model id, however the runtime spelled it, to one of `tags`.
 *
 * `tags` is the market table's own key list, passed in rather than imported so
 * this file stays free of `pricing.ts` and testable on its own, the way
 * `billing.ts` and `plan.ts` are.
 *
 * Order is exact, then hand-written alias, then the derived form. Exact first
 * so an operator serving through ollama takes no new code path at all, and
 * alias before derived so a hand verification always beats a parse.
 */
export function matchModel(
  id: string,
  tags: string[],
  aliases: Record<string, string> = ALIASES,
): Match {
  const raw = String(id ?? '').trim();
  if (!raw) return { tag: null, how: 'none', canonical: '' };

  if (tags.includes(raw)) return { tag: raw, how: 'exact', canonical: canonical(raw) };

  const alias = aliases[raw] ?? aliases[raw.toLowerCase()];
  if (alias && tags.includes(alias)) return { tag: alias, how: 'alias', canonical: canonical(raw) };

  const want = canonical(raw);
  if (!want) return { tag: null, how: 'none', canonical: want };
  // Equality, never proximity. A tag whose canonical form merely contains or
  // begins with this one is a different model.
  const hit = tags.find(t => canonical(t) === want);
  return hit ? { tag: hit, how: 'derived', canonical: want } : { tag: null, how: 'none', canonical: want };
}

/**
 * Whether two tags would be indistinguishable after canonicalisation.
 *
 * Used by the test that guards the market table. If two priced models ever
 * reduce to one string, the parse would pick whichever came first in the list
 * and quote one model's price for the other's weights, silently, which is the
 * exact failure this whole file is arranged to prevent.
 */
export function collisions(tags: string[]): Array<[string, string]> {
  const seen = new Map<string, string>();
  const clashes: Array<[string, string]> = [];
  for (const t of tags) {
    const c = canonical(t);
    const prev = seen.get(c);
    if (prev !== undefined) clashes.push([prev, t]);
    else seen.set(c, t);
  }
  return clashes;
}
