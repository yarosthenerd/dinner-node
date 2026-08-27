/**
 * What a node actually earns, and what it costs to earn it.
 *
 * This exists because the hosting page needs to answer "what would I make",
 * and that is the single easiest number in this project to get dishonestly
 * wrong. An earlier version of the pitch claimed $0.60/hour for an average PC;
 * the real figure at the rate then registered was about $0.005. A recruitment
 * page that repeats that mistake costs the project its credibility with
 * exactly the people it is trying to recruit.
 *
 * So the rule here is the same one the rest of the repo follows: measured
 * numbers are marked measured, derived numbers show their derivation, and the
 * assumptions a reader would want to challenge are inputs rather than
 * constants buried in a formula.
 *
 * The dominant term is NOT hardware. It is utilisation, and today it is close
 * to zero because the network has almost no demand. Any calculator that
 * defaults utilisation to 100% is selling something.
 */
import { CATALOG, fit, type Candidate } from './models.js';
import { MARKET_ID, PINNED, pickTarget, type Policy } from './pricing.js';

/** One generation measured on one machine. Nothing here is interpolated. */
export type Measurement = {
  model: string;
  /** Resident weights, MiB, as the registry serves them. */
  weightsMB: number;
  ctx: number;
  tokensPerSecond: number;
  /** Percent of the model ollama actually placed on the GPU. Below 100 the
   *  number above is a spill measurement and means nothing for a machine that
   *  can hold the model. */
  onGpuPercent: number;
  machine: string;
  measured: string;
};

/**
 * The reference machine, measured 2026-08-27 with `ollama /api/generate`,
 * `think` off, 300 tokens predicted, one model resident at a time and the
 * model unloaded between runs. The resident split was read from `/api/ps`
 * immediately after each run, which is what makes the spill rows honest: an
 * earlier pass reported 27.7 tok/s for qwen3:8b and it was contention with a
 * model the node had kept alive, not the model's speed.
 *
 * `tokensPerSecond` is decode only (`eval_count / eval_duration`). Prompt
 * processing and model load are excluded and both are real costs to a guest.
 */
export const REFERENCE_MACHINE = 'RTX 5070 Ti Laptop, 12227 MiB VRAM, 30 GB RAM';

export const MEASURED: Measurement[] = [
  { model: 'llama3.2:1b', weightsMB: 1259, ctx: 16384, tokensPerSecond: 215.5, onGpuPercent: 100, machine: REFERENCE_MACHINE, measured: '2026-08-27' },
  { model: 'qwen3:8b', weightsMB: 4987, ctx: 16384, tokensPerSecond: 49.5, onGpuPercent: 100, machine: REFERENCE_MACHINE, measured: '2026-08-27' },
  // Both of these SPILL on the reference machine and are kept precisely for
  // that: they are what a mis-sized node looks like, and the gap between them
  // is the argument for the MoE. Same card, same spill, 9x apart, because the
  // dense model moves 27B of weights per token and the MoE moves 3B.
  { model: 'qwen3.8:27b', weightsMB: 16920, ctx: 8192, tokensPerSecond: 4.3, onGpuPercent: 49.4, machine: REFERENCE_MACHINE, measured: '2026-08-27' },
  { model: 'qwen3.6:35b-a3b', weightsMB: 21573, ctx: 16384, tokensPerSecond: 40.4, onGpuPercent: 42.8, machine: REFERENCE_MACHINE, measured: '2026-08-27' },
];

/**
 * Effective memory bandwidth of the reference machine, in MiB/s, derived from
 * the two rows above that actually fit.
 *
 * Decoding one token reads the whole of a dense model's weights, so tok/s x
 * weightsMB is a constant for a given machine. The two fitting rows give
 * 271,300 and 246,857, which agree to within 10% and are averaged here. That
 * agreement is the evidence the law holds; the earlier spilled reading did not
 * fit it and that is how the contamination was caught.
 *
 * Note this is EFFECTIVE, not the number on the spec sheet. 259,079 MiB/s is
 * about 272 GB/s, well under this card's theoretical figure, which is expected:
 * it was drawing 65 W at peak. Scale by measured throughput where you can, not
 * by a manufacturer's bandwidth.
 */
export const REFERENCE_BANDWIDTH_MIB_S = Math.round(
  MEASURED.filter(m => m.onGpuPercent >= 100)
    .reduce((s, m) => s + m.tokensPerSecond * m.weightsMB, 0)
  / MEASURED.filter(m => m.onGpuPercent >= 100).length,
);

/** How badly a spilled model runs, relative to the same model held whole.
 *  Derived from the one pair we have and deliberately not dressed up as more:
 *  it is a warning, not a prediction. */
export const SPILL_IS_UNUSABLE_BELOW = 90;

export type Estimate = {
  pick: Candidate;
  fitsWhole: boolean;
  /** Largest context that fits alongside the weights. */
  maxCtx: number;
  /** Decode throughput. `source` says whether this was measured on the
   *  reference machine, scaled from it, or supplied by the caller. */
  tokensPerSecond: number;
  tokensPerSecondSource: 'measured' | 'scaled' | 'scaled-moe' | 'spilled-floor' | 'given' | 'unknown';
  /** USD per million output tokens this node would charge. */
  usdPerMillion: number;
  /** The market band the price came from, and how thin it is. */
  band: { median: number; providers: number; measured: string } | null;
  grossUsdPerHour: number;
  /** All figures below are per 30-day month at the given hours and utilisation. */
  grossUsdPerMonth: number;
  gasUsdPerMonth: number;
  powerUsdPerMonth: number;
  netUsdPerMonth: number;
  tokensPerMonth: number;
};

export type Inputs = {
  /** Total VRAM in MiB. probeHardware allots 90% of this to a model. */
  vramMB: number;
  /** Hours per day the machine is available to serve. */
  hoursPerDay: number;
  /** Fraction of those hours that actually carry a job, 0..1. This is the
   *  number that decides the answer and the one nobody can predict. */
  utilisation: number;
  /** Context the operator intends to advertise. */
  ctx: number;
  /** Watts drawn while generating. */
  watts: number;
  /** Electricity price, USD per kWh. */
  usdPerKwh: number;
  /** Assumed MON price. Testnet MON is worth nothing; this only converts a USD
   *  target into the wei the contract stores, and every dollar figure derived
   *  from it is worth exactly what the assumption is. */
  monUsd: number;
  /** Effective bandwidth of the operator's card in MiB/s, if known. Defaults
   *  to the reference machine, which is a laptop and is not a fast card. */
  bandwidthMiBs?: number;
  /** Override the throughput estimate entirely. An operator who has run
   *  `ollama run --verbose` knows this better than any formula here. */
  tokensPerSecond?: number;
  policy?: Policy;
  discount?: number;
};

/** Gas as a share of gross. host.ts settles once the unsettled tokens are worth
 *  SETTLE_GAS_MULTIPLE times what the settlement costs, so gas is 1/k of what
 *  it collects, by construction rather than by estimate. k defaults to 10. */
export const gasShareOfGross = (settleGasMultiple = 10) => 1 / settleGasMultiple;

/** The best model for a budget, using exactly the arithmetic setup uses. */
export function recommendForVram(vramMB: number, ctx: number) {
  const budgetMB = Math.floor(vramMB * 0.9);
  const scored = CATALOG.map(c => ({ c, f: fit(c.weightsMB, c.kvPerTokenB, ctx, budgetMB, c.maxCtx) }));
  const fitting = scored.filter(s => s.f.fits);
  const chosen = fitting.length ? fitting[fitting.length - 1] : scored[0];
  return { pick: chosen.c, fit: chosen.f, fitsWhole: chosen.f.fits, budgetMB };
}

/** What this node charges for the model it would serve, from the same band the
 *  live nodes price against. Returns null for a model with no listing. */
export function priceFor(tag: string, policy: Policy = 'median', discount = 0.9) {
  const orId = MARKET_ID[tag];
  const band = orId ? PINNED[orId] : undefined;
  if (!band) return null;
  return { usdPerMillion: pickTarget(band, policy, discount), band };
}

export function estimate(input: Inputs): Estimate {
  const { pick, fit: f, fitsWhole } = recommendForVram(input.vramMB, input.ctx);

  // Throughput, in strict order of how much we actually know. Every branch
  // below reports WHICH branch it took, because the difference between a
  // measurement and an extrapolation is the difference between this page being
  // useful and it being the "$0.60/hour" claim again.
  let tokensPerSecond: number;
  let tokensPerSecondSource: Estimate['tokensPerSecondSource'];
  const bw = input.bandwidthMiBs ?? REFERENCE_BANDWIDTH_MIB_S;
  const onReference = bw === REFERENCE_BANDWIDTH_MIB_S;
  const clean = MEASURED.find(m => m.model === pick.tag && m.onGpuPercent >= SPILL_IS_UNUSABLE_BELOW);
  const spilled = MEASURED.find(m => m.model === pick.tag && m.onGpuPercent < SPILL_IS_UNUSABLE_BELOW);
  // Bytes read to decode one token. For an MoE this is the ACTIVE weights, an
  // order of magnitude below the resident ones.
  const perToken = pick.activeMB ?? pick.weightsMB;

  if (input.tokensPerSecond !== undefined && input.tokensPerSecond > 0) {
    tokensPerSecond = input.tokensPerSecond;
    tokensPerSecondSource = 'given';
  } else if (!fitsWhole) {
    // Checked BEFORE the measured branch, not after. A measurement taken on a
    // machine that could hold the model says nothing about a machine that
    // cannot, and reporting it as "measured" to an operator whose card is too
    // small is the most misleading thing this file could do: it would have
    // quoted llama3.2:1b at 215 tok/s to someone with 2 GB of VRAM.
    // The model does not fit. There is no honest formula for this case: the
    // two spilled rows in MEASURED sit 9x apart on identical hardware, because
    // what matters is which tensors landed on the CPU, not the model's size.
    // Report the measurement if we have one, and call it a floor.
    if (spilled) { tokensPerSecond = spilled.tokensPerSecond; tokensPerSecondSource = 'spilled-floor'; }
    else { tokensPerSecond = 0; tokensPerSecondSource = 'unknown'; }
  } else if (clean && onReference) {
    tokensPerSecond = clean.tokensPerSecond;
    tokensPerSecondSource = 'measured';
  } else {
    // Fits, and we have no measurement of it. One token reads the weights that
    // are active for that token, so throughput is bandwidth over those bytes.
    // Validated on the two clean rows in MEASURED, which agree to within 10%.
    tokensPerSecond = bw / perToken;
    tokensPerSecondSource = pick.activeMB ? 'scaled-moe' : 'scaled';
  }

  const priced = priceFor(pick.tag);
  const usdPerMillion = priced?.usdPerMillion ?? 0;

  const secondsPerMonth = input.hoursPerDay * 3600 * 30 * Math.max(0, Math.min(1, input.utilisation));
  const tokensPerMonth = tokensPerSecond * secondsPerMonth;
  const grossUsdPerMonth = (tokensPerMonth / 1e6) * usdPerMillion;
  const grossUsdPerHour = tokensPerSecond * 3600 / 1e6 * usdPerMillion;

  const gasUsdPerMonth = grossUsdPerMonth * gasShareOfGross();
  const kwh = (input.watts / 1000) * (secondsPerMonth / 3600);
  const powerUsdPerMonth = kwh * input.usdPerKwh;

  return {
    pick, fitsWhole, maxCtx: f.maxCtx,
    tokensPerSecond, tokensPerSecondSource,
    usdPerMillion,
    band: priced ? { median: priced.band.median, providers: priced.band.providers, measured: priced.band.measured } : null,
    grossUsdPerHour, grossUsdPerMonth, gasUsdPerMonth, powerUsdPerMonth,
    netUsdPerMonth: grossUsdPerMonth - gasUsdPerMonth - powerUsdPerMonth,
    tokensPerMonth,
  };
}
