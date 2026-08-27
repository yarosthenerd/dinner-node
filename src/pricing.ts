/**
 * What to charge, derived from the market for the exact model being served.
 *
 * The rate was a single constant for every model, set by hand and justified in
 * TODO.md against a price band for a model this node does not run. That is two
 * defects in one number: a 1B model and a 35B MoE were billed identically, and
 * the justification could not be checked by anyone, including us.
 *
 * This prices each model against its own listing on OpenRouter, which is the
 * same place a buyer comparing us would look, and it records the whole band
 * rather than one number so the claim is inspectable. /health publishes the
 * reference, the policy and the result, so "we sit below the median of ten
 * providers for the model we actually serve" is a statement a reviewer can
 * verify in one request rather than take on trust.
 *
 * Nothing here reaches the chain. `host.ts` turns the wei figure into the rate
 * it registers, and this file stays pure enough to test.
 */

/** Our model tag to the OpenRouter id for the same weights. Verified by hand
 *  on 2026-08-27; an entry that is wrong prices a model against a different
 *  model, so this table is deliberately explicit rather than a fuzzy match. */
export const MARKET_ID: Record<string, string> = {
  'llama3.2:1b': 'meta-llama/llama-3.2-1b-instruct',
  'qwen3:8b': 'qwen/qwen3-8b',
  'qwen3:14b': 'qwen/qwen3-14b',
  'qwen3.6:35b-a3b': 'qwen/qwen3.6-35b-a3b',
  'qwen3.8:27b': 'qwen/qwen3.8-27b',
};

/**
 * Last known market, measured 2026-08-27 from the OpenRouter endpoints API.
 * Output price in USD per million tokens.
 *
 * This exists so a node with no internet, or one starting while OpenRouter is
 * down, prices sanely instead of falling back to a constant that means
 * nothing. It is a floor on quality of information, not a substitute for the
 * live figure: `resolveRate` prefers the live band every time it can get one.
 */
export const PINNED: Record<string, Band> = {
  'meta-llama/llama-3.2-1b-instruct': {
    min: 0.201, median: 0.201, max: 0.201, providers: 1, measured: '2026-08-27',
    endpoints: [
      { name: 'Cloudflare', inUsd: 0.027, outUsd: 0.201 },
    ],
  },
  'qwen/qwen3-8b': {
    min: 0.455, median: 0.455, max: 0.455, providers: 1, measured: '2026-08-27',
    endpoints: [
      { name: 'Alibaba', inUsd: 0.117, outUsd: 0.455 },
    ],
  },
  'qwen/qwen3-14b': {
    min: 0.220, median: 0.240, max: 0.910, providers: 3, measured: '2026-08-27',
    endpoints: [
      { name: 'NextBit', inUsd: 0.100, outUsd: 0.220 },
      { name: 'DeepInfra', inUsd: 0.120, outUsd: 0.240 },
      { name: 'Alibaba', inUsd: 0.227, outUsd: 0.910 },
    ],
  },
  'qwen/qwen3.8-27b': {
    min: 2.400, median: 3.000, max: 3.400, providers: 12, measured: '2026-08-27',
    endpoints: [
      { name: 'Morph', inUsd: 0.289, outUsd: 2.400 },
      { name: 'AkashML', inUsd: 0.400, outUsd: 2.550 },
      { name: 'Alibaba', inUsd: 0.425, outUsd: 2.550 },
      { name: 'Chutes', inUsd: 0.350, outUsd: 2.750 },
      { name: 'Phala', inUsd: 0.400, outUsd: 3.000 },
      { name: 'CoreWeave', inUsd: 0.400, outUsd: 3.000 },
      { name: 'Novita', inUsd: 0.500, outUsd: 3.000 },
      { name: 'Cloudflare', inUsd: 0.450, outUsd: 3.200 },
      { name: 'Reka', inUsd: 0.450, outUsd: 3.200 },
      { name: 'Venice', inUsd: 0.450, outUsd: 3.200 },
      { name: 'Parasail', inUsd: 0.450, outUsd: 3.200 },
      { name: 'Io Net', inUsd: 0.480, outUsd: 3.400 },
    ],
  },
  'qwen/qwen3.6-35b-a3b': {
    min: 0.700, median: 1.114, max: 1.600, providers: 10, measured: '2026-08-27',
    endpoints: [
      { name: 'Darkbloom', inUsd: 0.050, outUsd: 0.700 },
      { name: 'AkashML', inUsd: 0.100, outUsd: 0.900 },
      { name: 'DeepInfra', inUsd: 0.100, outUsd: 0.950 },
      { name: 'Venice', inUsd: 0.100, outUsd: 1.000 },
      { name: 'Parasail', inUsd: 0.150, outUsd: 1.000 },
      { name: 'AtlasCloud', inUsd: 0.186, outUsd: 1.114 },
      { name: 'Io Net', inUsd: 0.190, outUsd: 1.190 },
      { name: 'CoreWeave', inUsd: 0.250, outUsd: 1.250 },
      { name: 'Phala', inUsd: 0.200, outUsd: 1.270 },
      { name: 'SiliconFlow', inUsd: 0.200, outUsd: 1.600 },
    ],
  },
  // Deliberately absent: qwen3:1.7b, qwen2.5:3b and qwen3:4b. All three were
  // queried on 2026-08-27 and NONE of them has an OpenRouter listing, because
  // nobody sells a model that small as an API. That is a fact worth keeping
  // rather than papering over with a made-up price: a node serving one of them
  // has no market to price against, and anything that quotes an income for it
  // is quoting a number with no referent.
};

export type Endpoint = {
  name: string;
  /** USD per million INPUT tokens. Kept because we charge nothing for input
   *  and every listed rival does, which is not visible in an output column. */
  inUsd: number;
  /** USD per million OUTPUT tokens. */
  outUsd: number;
};

export type Band = {
  /** USD per million OUTPUT tokens. Output, because that is what settle()
   *  charges for; billing input against an output band would overcharge by the
   *  ratio between them, which on this model is about 10x. */
  min: number;
  median: number;
  max: number;
  providers: number;
  measured: string;
  /** Every listed provider, when known. This is what makes the input-side
   *  comparison possible rather than assumed. */
  endpoints?: Endpoint[];
};

/**
 * What a rival that bills BOTH sides actually costs, expressed as an
 * output-only price so it can be compared with ours.
 *
 * `ratio` is input tokens per output token for the workload in question. A
 * rival charging `inUsd` for input collects `ratio * inUsd` extra per output
 * token, so their true price for the same job is `outUsd + ratio * inUsd`.
 * Comparing bare output columns silently assumes ratio 0, which is a workload
 * nobody runs.
 */
export function rivalEffective(e: Endpoint, ratio: number): number {
  return e.outUsd + Math.max(0, ratio) * e.inUsd;
}

/**
 * The input:output ratio at which we become cheaper than one rival.
 *
 * 0 means we are already cheaper on output alone. Infinity means never, which
 * happens only against a rival that charges nothing for input and less than us
 * for output. This is the honest form of "we do not charge for input": it is
 * worth a specific amount, and that amount is a number.
 */
export function crossoverRatio(e: Endpoint, ourOutUsd: number): number {
  if (ourOutUsd <= e.outUsd) return 0;
  if (e.inUsd <= 0) return Infinity;
  return (ourOutUsd - e.outUsd) / e.inUsd;
}

/** How many listed providers we undercut at a given workload shape. */
export function cheaperThanCount(band: Band, ourOutUsd: number, ratio: number): number {
  return (band.endpoints ?? []).filter(e => ourOutUsd < rivalEffective(e, ratio)).length;
}

/** Where in the band to sit. `median` is the default because it is the only
 *  position that is both defensible and stable: `min` is a race against
 *  whoever is currently dumping capacity, and `max` is not a market position. */
export type Policy = 'min' | 'median' | 'max';

/** MON has no market price on testnet, so this is a modelling constant and is
 *  stated as one. It only converts a USD target into the wei figure the
 *  contract stores; every dollar number published alongside it is derived from
 *  this and is no better than the assumption. */
export const DEFAULT_MON_USD = 0.03;

/** Below this a settlement costs more gas than the tokens are worth, however
 *  attractive the headline price looks. Expressed in tokens so it can be
 *  compared against a real job. */
export function breakEvenTokens(settleGasUnits: bigint, gasPriceWei: bigint, ratePerMillionWei: bigint): number {
  if (ratePerMillionWei <= 0n) return Infinity;
  const cost = settleGasUnits * gasPriceWei;
  // Tokens whose value equals one settle. Rounded up: a fractional token does
  // not exist and rounding down would advertise a break-even we do not meet.
  return Number((cost * 1_000_000n + ratePerMillionWei - 1n) / ratePerMillionWei);
}

/** USD per million to wei per million, at an assumed MON price. */
export function weiPerMillion(usdPerMillion: number, monUsd = DEFAULT_MON_USD): bigint {
  if (!(usdPerMillion > 0) || !(monUsd > 0)) return 0n;
  const mon = usdPerMillion / monUsd;
  // Through a string rather than Number arithmetic on 1e18: the float loses
  // the low digits and the registered rate would not match the published one.
  return BigInt(Math.round(mon * 1e6)) * 10n ** 12n;
}

/** The inverse, for reporting what we actually charge in the units a buyer
 *  compares. */
export function usdPerMillion(wei: bigint, monUsd = DEFAULT_MON_USD): number {
  return (Number(wei) / 1e18) * monUsd;
}

export function pickTarget(band: Band, policy: Policy, discount: number): number {
  const base = policy === 'min' ? band.min : policy === 'max' ? band.max : band.median;
  return base * discount;
}

/**
 * Fetch the live band for one OpenRouter model.
 *
 * `fetchImpl` is injected so the tests never touch the network. Returns null
 * rather than throwing: a pricing lookup that fails must not stop a node
 * starting, it must fall back to PINNED and say so.
 */
export async function fetchBand(
  orId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<Band | null> {
  try {
    const r = await fetchImpl(`https://openrouter.ai/api/v1/models/${orId}/endpoints`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const j = await r.json() as any;
    const eps = j?.data?.endpoints ?? [];
    const endpoints: Endpoint[] = eps
      .map((e: any) => ({
        name: String(e?.provider_name ?? 'unknown'),
        inUsd: Number(e?.pricing?.prompt) * 1e6,
        outUsd: Number(e?.pricing?.completion) * 1e6,
      }))
      .filter((e: Endpoint) => Number.isFinite(e.outUsd) && e.outUsd > 0)
      // Input may legitimately be zero on a free endpoint; only a NaN is bad.
      .map((e: Endpoint) => ({ ...e, inUsd: Number.isFinite(e.inUsd) ? e.inUsd : 0 }))
      .sort((a: Endpoint, b: Endpoint) => a.outUsd - b.outUsd);
    if (!endpoints.length) return null;
    const outs = endpoints.map(e => e.outUsd);
    return {
      min: outs[0],
      median: outs[Math.floor(outs.length / 2)],
      max: outs[outs.length - 1],
      providers: outs.length,
      measured: new Date().toISOString().slice(0, 10),
      endpoints,
    };
  } catch {
    return null;
  }
}

export type Resolved = {
  ratePerMillionWei: bigint;
  usdPerMillion: number;
  band: Band | null;
  /** 'live' | 'pinned' | 'override' | 'none'. Published, so nobody has to
   *  guess whether a quoted price came from the market or from a default. */
  source: string;
  orId: string | null;
  policy: Policy;
  discount: number;
};

/**
 * The whole decision, in one place.
 *
 * An explicit override always wins, because an operator who sets a rate has
 * said something this file should not argue with. Otherwise: live band,
 * pinned band, and if the model is not in the table at all, no rate is
 * invented and the caller keeps whatever default it had.
 */
export async function resolveRate(opts: {
  model: string;
  overrideWei?: bigint | null;
  policy?: Policy;
  discount?: number;
  monUsd?: number;
  fetchImpl?: typeof fetch;
}): Promise<Resolved> {
  const policy = opts.policy ?? 'median';
  const discount = opts.discount ?? 1;
  const monUsd = opts.monUsd ?? DEFAULT_MON_USD;
  const orId = MARKET_ID[opts.model] ?? null;

  if (opts.overrideWei && opts.overrideWei > 0n) {
    return {
      ratePerMillionWei: opts.overrideWei,
      usdPerMillion: usdPerMillion(opts.overrideWei, monUsd),
      band: orId ? PINNED[orId] ?? null : null,
      source: 'override', orId, policy, discount,
    };
  }
  if (!orId) {
    return { ratePerMillionWei: 0n, usdPerMillion: 0, band: null, source: 'none', orId: null, policy, discount };
  }

  const live = await fetchBand(orId, opts.fetchImpl ?? fetch);
  const band = live ?? PINNED[orId] ?? null;
  if (!band) {
    return { ratePerMillionWei: 0n, usdPerMillion: 0, band: null, source: 'none', orId, policy, discount };
  }
  const usd = pickTarget(band, policy, discount);
  return {
    ratePerMillionWei: weiPerMillion(usd, monUsd),
    usdPerMillion: usd,
    band,
    source: live ? 'live' : 'pinned',
    orId, policy, discount,
  };
}

/** One line for the log and for /health, carrying the numbers that justify it. */
export function describeRate(r: Resolved): string {
  if (!r.band) return `rate ${r.ratePerMillionWei} wei/M (${r.source})`;
  const pos = r.usdPerMillion <= r.band.min ? 'at or under the cheapest'
    : r.usdPerMillion < r.band.median ? 'below the median'
    : r.usdPerMillion === r.band.median ? 'at the median'
    : 'above the median';
  return `$${r.usdPerMillion.toFixed(3)}/M output, ${pos} of ${r.band.providers} provider(s) `
    + `($${r.band.min.toFixed(3)} to $${r.band.max.toFixed(3)}, median $${r.band.median.toFixed(3)}) `
    + `for ${r.orId} [${r.source}]`;
}

/** The input-side line for the log, which is the part the output column hides. */
export function describeFreeInput(r: Resolved): string | null {
  if (!r.band?.endpoints?.length) return null;
  const cheapest = r.band.endpoints[0];
  const x = crossoverRatio(cheapest, r.usdPerMillion);
  const atOne = cheaperThanCount(r.band, r.usdPerMillion, 1);
  const atZero = cheaperThanCount(r.band, r.usdPerMillion, 0);
  const n = r.band.endpoints.length;
  const cross = x === 0 ? 'at any prompt length'
    : x === Infinity ? 'never on price alone'
    : `once a prompt is ${x.toFixed(1)}x the answer`;
  return `input free (they all bill it): cheaper than ${atZero}/${n} on output alone, `
    + `${atOne}/${n} at 1:1, and cheaper than ${cheapest.name} at $${cheapest.outUsd.toFixed(3)}+$${cheapest.inUsd.toFixed(3)} ${cross}`;
}
