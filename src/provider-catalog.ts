/**
 * The model document an aggregator reads, in OpenRouter's provider schema.
 *
 * Distribution is the gap this project actually has, and the listing is the
 * mechanism. `/v1/chat/completions` is how a buyer calls the node; this is how
 * a router learns what the node is, what it costs and how much of it there is.
 *
 * Everything here is derived from numbers the project already holds and can
 * defend: the price from `pricing.ts`, which resolves against the same public
 * band a buyer would check, and the throughput from the measurement in
 * `scripts/bench-throughput.py` rather than from a hopeful constant. Nothing
 * is declared that the node does not do. An absent capability is a capability
 * the router will not route to us, which is the correct outcome when we do not
 * have it, and much cheaper than a request we answer badly.
 *
 * Pure, so the shape is testable without a chain or an engine.
 */

export type Descriptor =
  | { type: 'boolean' }
  | { type: 'integer'; min?: number; max?: number; unit?: string }
  | { type: 'range'; min: number; max: number };

export type Price = { type: string; unit: string; cost_usd: string };
export type Capacity = { type: string; unit?: string; per?: 'minute' | 'hour' | 'day'; value: number };

export type CatalogInput = {
  /** The id a caller sends, which must be one /v1/chat/completions accepts. */
  id: string;
  name?: string;
  /** Output price in USD per million tokens, as resolved from the market band. */
  usdPerMillion: number;
  /** The whole context, prompt plus answer. */
  contextTokens: number;
  /** The most this node will generate for one request. */
  maxOutputTokens: number;
  /** Measured generation rate. Null when this node has not measured itself. */
  tokensPerSecond: number | null;
  /** How many jobs it will serve at once. */
  maxConcurrent: number;
  /** ISO country code of the machine, when the operator has declared one. */
  countryCode?: string | null;
  region?: string | null;
  /** Off until an operator says the node is ready to take routed traffic. */
  isReady: boolean;
  createdAt?: number;
};

/**
 * Costs are strings in USD per unit, per the schema, and this is why: a token
 * price is around 1e-6 and JSON numbers are doubles, so the obvious encoding
 * loses precision exactly where the money is. 12 decimal places is far past a
 * tenth of a nano-dollar and well inside what a double can hold before the
 * string is written.
 */
export const perToken = (usdPerMillion: number): string => (usdPerMillion / 1_000_000).toFixed(12);

export function modelDocument(i: CatalogInput): Record<string, unknown> {
  const completion = perToken(i.usdPerMillion);
  return {
    schema_version: '2.4',
    id: i.id,
    name: i.name ?? i.id,
    ...(i.createdAt ? { created: i.createdAt } : {}),

    input_modalities: [{
      type: 'text',
      supported_inputs: {
        // The one number a router most needs and the one most often wrong. It
        // is the node's real window, which is a configuration choice here and
        // not a model property.
        max_tokens: { type: 'integer', min: 1, max: i.contextTokens, unit: 'token' } as Descriptor,
      },
      // Zero, and not omitted. `settle()` charges tokensDelta, which counts
      // only tokens the node GENERATED, so a prompt is free here however long
      // it is. Stating it as a price of zero is the difference between a
      // buyer's router knowing that and assuming a default.
      pricing: [{ type: 'prompt', unit: 'token', cost_usd: '0.000000000000' }] as Price[],
    }],

    output_modalities: [{
      type: 'text',
      max_length: { value: i.maxOutputTokens, unit: 'token' },
      streaming: true,
      supported_parameters: {
        // Only what the endpoint honours. Sampling parameters are accepted and
        // ignored, so declaring them would be a promise the node does not
        // keep, and tools are refused outright rather than silently dropped.
        max_tokens: { type: 'integer', min: 1, max: i.maxOutputTokens, unit: 'token' } as Descriptor,
      },
      pricing: [
        { type: 'completion', unit: 'token', cost_usd: completion },
        // Reasoning is billed at the same rate as visible output, because it
        // is compute the node performs and delivers, and because that is what
        // settle() charges for. Declared rather than folded into completion so
        // a router costing a reasoning model is not surprised.
        { type: 'internal_reasoning', unit: 'token', cost_usd: completion },
      ] as Price[],
      capacity: [
        // Measured, and omitted entirely when it has not been. An absent
        // capacity means undeclared rather than zero, which is the honest
        // reading for a node that has not timed itself yet.
        ...(i.tokensPerSecond
          ? [{ type: 'completion', unit: 'token', per: 'minute', value: Math.floor(i.tokensPerSecond * 60) } as Capacity]
          : []),
        { type: 'concurrency', value: i.maxConcurrent } as Capacity,
      ],
    }],

    // False until an operator flips it. A node that lists itself as ready on
    // the day it is installed gets routed traffic it has never served.
    is_ready: i.isReady,
    ...(i.countryCode
      ? { datacenters: [{ country_code: i.countryCode, ...(i.region ? { region: i.region } : {}) }], deployment_region: i.countryCode }
      : {}),
    compliance: {
      // Both false, deliberately. Node operators are asked not to retain
      // prompts, and an ask is not an attestation: the machines are other
      // people's and nothing here can enforce or prove it. Claiming zero data
      // retention would be the single most checkable false claim we could make.
      zdr: false,
      hipaa: false,
    },
  };
}

export function catalogDocument(models: CatalogInput[]): string {
  return JSON.stringify({ data: models.map(modelDocument) });
}
