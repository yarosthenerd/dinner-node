/**
 * Which model this machine should serve.
 *
 * Two questions, one answer. For an operator with models already installed:
 * which of them fits, and at what context. For an operator with none: which
 * one to pull.
 *
 * "Fits" is the whole point. Ollama does not refuse a model that is too large
 * for the GPU; it loads what it can and runs the rest on CPU, silently. The
 * reference machine here serves a 27B on 12 GB of VRAM at 4 tok/s with 56% of
 * the layers on CPU, which is slower than a guest will wait. A node that picks
 * a model it can hold entirely in VRAM is the cheapest speed available.
 *
 * Sizing arithmetic, all of it:
 *
 *   need = weights + kv_cache(context) + compute_buffers
 *   kv_cache = context x layers x kv_heads x (key_len + value_len) x 2 bytes
 *
 * The KV term is not a rounding error. qwen3:8b is 5.0 GB of weights and 4.8 GB
 * of KV cache at a 32768 context: sizing on weights alone is out by nearly 2x,
 * and that error is exactly what puts half a model on the CPU.
 */
import type { Hardware } from './hardware.js';

const MB = 1024 * 1024;

/**
 * Ollama's own allocations beyond weights and KV: compute buffers, the graph,
 * and the output tensor. Roughly flat across the sizes here, measured high on
 * purpose because being 400 MB pessimistic costs nothing and being 400 MB
 * optimistic costs half the layers.
 */
const OVERHEAD_MB = 600;

export type Candidate = {
  tag: string;
  /** Download and resident weight size, MiB, Q4_K_M as the registry serves it. */
  weightsMB: number;
  /** Bytes of f16 KV cache per token of context. */
  kvPerTokenB: number;
  /** Context the weights were trained for. Asking for more degrades quality. */
  maxCtx: number;
  note: string;
};

/**
 * Every number here was measured on 2026-08-26, not remembered: weights from
 * the sum of the registry manifest layers, KV geometry from the GGUF metadata
 * header of the published blob. Ordered smallest to largest, which is also
 * roughly weakest to strongest, so "the last one that fits" is the pick.
 *
 * Deliberately short. This is not a model directory, it is a default for an
 * operator who has not chosen one, and every extra entry is another thing to
 * keep true.
 */
export const CATALOG: Candidate[] = [
  { tag: 'llama3.2:1b', weightsMB: 1259, kvPerTokenB: 32768, maxCtx: 131072,
    note: 'runs on anything, including CPU only' },
  { tag: 'qwen3:1.7b', weightsMB: 1297, kvPerTokenB: 114688, maxCtx: 40960,
    note: 'stronger than its size, heavy KV cache' },
  { tag: 'qwen2.5:3b', weightsMB: 1841, kvPerTokenB: 36864, maxCtx: 32768,
    note: 'cheapest long context of the small models' },
  { tag: 'qwen3:4b', weightsMB: 2384, kvPerTokenB: 147456, maxCtx: 262144,
    note: 'the sweet spot on an 8 GB card' },
  { tag: 'qwen3:8b', weightsMB: 4987, kvPerTokenB: 147456, maxCtx: 40960,
    note: 'general purpose, wants 12 GB to hold a full context' },
  { tag: 'qwen3:14b', weightsMB: 8850, kvPerTokenB: 163840, maxCtx: 40960,
    note: 'noticeably better answers, needs 16 GB' },
  // The 24 GB entry, and the one row here whose sizing is measured but whose
  // real-world speed is not. Every number below came from the published blob on
  // 2026-08-27, the same way every row above it did: weights are the sum of the
  // manifest layers (16,032 MiB model plus an 888 MiB vision projector, counted
  // because ollama resides it), file_type Q4_K_M, and the KV geometry is
  // qwen35.block_count 65 x head_count_kv 4 x (key_length 256 + value_length
  // 256) x 2 = 266,240 B/token, read out of the GGUF metadata header.
  //
  // What is NOT measured is this model running well on a 24 GB card. The only
  // observation this project has of it is on a 12 GB card, where it spilled 56%
  // of its layers to CPU and served 4 tok/s. It is here on an operator
  // decision, backed by a second-hand report that it runs fine on a 24 GB card,
  // and it should be replaced with a real measurement when one exists.
  //
  // The KV figure is pessimistic by construction and probably by a lot:
  // qwen35.full_attention_interval is 4, so only every fourth layer keeps a
  // full cache, and kvPerTokenFromInfo does not model that. Being pessimistic
  // costs context and never costs a spill to CPU, which is the trade the whole
  // file is built on.
  //
  // At 90% of a 24 GB card it needs 17,520 MiB of weights and overhead against
  // a 22,118 MiB budget, leaving about 17k of context. Below the 35B on a
  // 32 GB card, so it takes nothing away from the tier above it.
  { tag: 'qwen3.8:27b', weightsMB: 16920, kvPerTokenB: 266240, maxCtx: 262144,
    note: 'dense 27B, the 24 GB pick; sizing measured, speed on 24 GB reported not measured' },
  // The top of the catalog. Without it a 32 GB card was told to serve a 14B,
  // which is a third of what it can hold. Measured 2026-08-27 from the local
  // registry manifest and the GGUF metadata header, the same way every row
  // above it was.
  //
  // Read the budget before reading the requirement: probeHardware allots 90%
  // of VRAM, so this needs 23,485 MiB at 16k context and a 24 GB card offers
  // 22,118. It is a 32 GB entry, not a 24 GB one, and the weights alone are
  // 21,573 MiB.
  //
  // Mixture of experts, which is what makes it the right top entry rather than
  // a dense model of similar size. Its KV cache is 83,968 B/token against the
  // dense 27B's 266,240, so on a 32 GB card it reaches 132k of context where
  // the dense model stops at 59k, and it activates 3B parameters per token, so
  // it answers at small-model speed while giving large-model answers.
  { tag: 'qwen3.6:35b-a3b', weightsMB: 21573, kvPerTokenB: 83968, maxCtx: 262144,
    note: 'MoE, 35B stored and 3B active: big-model answers at small-model speed, wants 32 GB' },
];

export type Fit = {
  /** Total MiB the model needs at the requested context. */
  needMB: number;
  fits: boolean;
  /** Largest context that fits the budget, 0 if the weights alone do not. */
  maxCtx: number;
};

export function fit(weightsMB: number, kvPerTokenB: number, ctx: number, budgetMB: number, trainedCtx = Infinity): Fit {
  const kvMB = (kvPerTokenB * ctx) / MB;
  const needMB = Math.ceil(weightsMB + kvMB + OVERHEAD_MB);
  const spare = budgetMB - weightsMB - OVERHEAD_MB;
  // Report the usable context in whole 1024s: ollama pads the KV cache to a
  // block boundary, and an operator is not going to type 27311.
  const raw = spare > 0 ? Math.floor((spare * MB) / kvPerTokenB / 1024) * 1024 : 0;
  return { needMB, fits: needMB <= budgetMB, maxCtx: Math.min(raw, trainedCtx) };
}

/**
 * KV geometry from an installed model, via ollama's /api/show. Exact where the
 * catalog is only a table, and it covers models the catalog never heard of,
 * which is most of what an operator already has installed.
 */
export function kvPerTokenFromInfo(info: Record<string, unknown>): number | null {
  const g = (suffix: string): number | null => {
    for (const [k, v] of Object.entries(info)) {
      if (k.endsWith(suffix) && typeof v === 'number') return v;
    }
    return null;
  };
  const layers = g('.block_count');
  const kvHeads = g('.attention.head_count_kv');
  const heads = g('.attention.head_count');
  const emb = g('.embedding_length');
  // Most architectures omit key_length when it is simply embedding/heads.
  const keyLen = g('.attention.key_length') ?? (emb && heads ? emb / heads : null);
  const valLen = g('.attention.value_length') ?? keyLen;
  if (!layers || !kvHeads || !keyLen || !valLen) return null;
  return layers * kvHeads * (keyLen + valLen) * 2;
}

export type Installed = {
  name: string;
  weightsMB: number;
  kvPerTokenB: number | null;
  trainedCtx: number;
  fit: Fit | null;
};

/**
 * Rank what is installed by what this machine can actually run. Best first,
 * where best is the largest model that still fits entirely: a bigger model
 * spilling to CPU is strictly worse than a smaller one that does not.
 */
export async function rankInstalled(budgetMB: number, ctx: number, ollamaUrl: string): Promise<Installed[]> {
  const tags = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) })
    .then(r => r.json() as Promise<any>);
  const out: Installed[] = [];
  for (const m of tags.models ?? []) {
    const weightsMB = Math.round((m.size ?? 0) / MB);
    let kvPerTokenB: number | null = null;
    let trainedCtx = Infinity;
    try {
      const show = await fetch(`${ollamaUrl}/api/show`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(8000),
      }).then(r => r.json() as Promise<any>);
      const info = (show.model_info ?? {}) as Record<string, unknown>;
      kvPerTokenB = kvPerTokenFromInfo(info);
      const c = Object.entries(info).find(([k]) => k.endsWith('.context_length'))?.[1];
      if (typeof c === 'number') trainedCtx = c;
    } catch { /* an unreadable model is still listed, just unranked */ }
    out.push({
      name: m.name, weightsMB, kvPerTokenB, trainedCtx,
      fit: kvPerTokenB ? fit(weightsMB, kvPerTokenB, ctx, budgetMB, trainedCtx) : null,
    });
  }
  // Fitting models first, largest of those first. Then the rest, smallest
  // first: if nothing fits, the least bad spill is the smallest model.
  return out.sort((a, b) => {
    const af = a.fit?.fits ? 1 : 0, bf = b.fit?.fits ? 1 : 0;
    if (af !== bf) return bf - af;
    return af ? b.weightsMB - a.weightsMB : a.weightsMB - b.weightsMB;
  });
}

/**
 * What to pull on a machine with nothing installed: the strongest catalog entry
 * that fits whole, or the smallest one if none do, since a CPU-only node still
 * works and llama3.2:1b is the model that runs everywhere.
 */
export function recommend(hw: Hardware, ctx: number): { pick: Candidate; fit: Fit; fitsWhole: boolean } {
  const scored = CATALOG.map(c => ({ c, f: fit(c.weightsMB, c.kvPerTokenB, ctx, hw.budgetMB, c.maxCtx) }));
  const fitting = scored.filter(s => s.f.fits);
  const chosen = fitting.length ? fitting[fitting.length - 1] : scored[0];
  return { pick: chosen.c, fit: chosen.f, fitsWhole: chosen.f.fits };
}

export const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
