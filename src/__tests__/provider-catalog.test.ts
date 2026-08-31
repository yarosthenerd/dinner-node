import { describe, expect, it } from 'vitest';
import { catalogDocument, modelDocument, perToken } from '../provider-catalog';

const base = {
  id: 'qwen3.8:27b',
  usdPerMillion: 1.002,
  contextTokens: 32768,
  maxOutputTokens: 2048,
  tokensPerSecond: 58,
  maxConcurrent: 2,
  isReady: false,
};

describe('per-token cost', () => {
  it('is a decimal string, because a JSON number loses the money', () => {
    // 1.002 per million is 1.002e-6. Encoded as a double and re-serialised it
    // is where a price quietly stops being the price.
    expect(perToken(1.002)).toBe('0.000001002000');
    expect(perToken(0)).toBe('0.000000000000');
    expect(typeof perToken(3)).toBe('string');
  });
});

describe('the model document', () => {
  const doc = modelDocument(base) as any;

  it('declares the schema version and one modality each way', () => {
    expect(doc.schema_version).toBe('2.4');
    expect(doc.input_modalities).toHaveLength(1);
    expect(doc.output_modalities).toHaveLength(1);
    expect(doc.input_modalities[0].type).toBe('text');
    expect(doc.output_modalities[0].type).toBe('text');
  });

  it('prices input at zero rather than leaving it out', () => {
    // The claim that pays: settle() bills only generated tokens, so a prompt
    // is free. Omitted, a router assumes a default and never sees it.
    const p = doc.input_modalities[0].pricing;
    expect(p).toEqual([{ type: 'prompt', unit: 'token', cost_usd: '0.000000000000' }]);
  });

  it('bills reasoning at the same rate as visible output', () => {
    const p = doc.output_modalities[0].pricing;
    expect(p.find((x: any) => x.type === 'completion').cost_usd).toBe('0.000001002000');
    expect(p.find((x: any) => x.type === 'internal_reasoning').cost_usd).toBe('0.000001002000');
  });

  it('declares only the parameters the endpoint actually honours', () => {
    // Sampling fields are accepted and ignored, and tools are refused. Either
    // one declared here is a promise /v1/chat/completions does not keep.
    const sp = doc.output_modalities[0].supported_parameters;
    expect(Object.keys(sp)).toEqual(['max_tokens']);
    expect(sp.max_tokens.max).toBe(2048);
    expect(doc.output_modalities[0].max_length).toEqual({ value: 2048, unit: 'token' });
    expect(doc.input_modalities[0].supported_inputs.max_tokens.max).toBe(32768);
  });

  it('turns measured throughput into a per-minute capacity', () => {
    const cap = doc.output_modalities[0].capacity;
    expect(cap).toContainEqual({ type: 'completion', unit: 'token', per: 'minute', value: 3480 });
    expect(cap).toContainEqual({ type: 'concurrency', value: 2 });
  });

  it('omits throughput entirely when the node has not measured itself', () => {
    // An absent capacity means undeclared, not zero. Publishing a guess would
    // be the same class of error as the 25 tok/s the roadmap carried for
    // months against a real 58.
    const d = modelDocument({ ...base, tokensPerSecond: null }) as any;
    const cap = d.output_modalities[0].capacity;
    expect(cap.some((c: any) => c.type === 'completion')).toBe(false);
    expect(cap).toContainEqual({ type: 'concurrency', value: 2 });
  });

  it('is not ready until an operator says so', () => {
    expect(doc.is_ready).toBe(false);
    expect((modelDocument({ ...base, isReady: true }) as any).is_ready).toBe(true);
  });

  it('claims neither zero retention nor HIPAA', () => {
    // The machines belong to other people. Asking them not to retain prompts
    // is not an attestation that they do not, and zdr is the most checkable
    // false claim available to this project.
    expect(doc.compliance).toEqual({ zdr: false, hipaa: false });
  });

  it('declares a location only when the operator gave one', () => {
    expect(doc.datacenters).toBeUndefined();
    expect(doc.deployment_region).toBeUndefined();
    const located = modelDocument({ ...base, countryCode: 'RS', region: 'belgrade' }) as any;
    expect(located.datacenters).toEqual([{ country_code: 'RS', region: 'belgrade' }]);
    expect(located.deployment_region).toBe('RS');
  });
});

describe('the catalog', () => {
  it('wraps the documents in a data array', () => {
    const j = JSON.parse(catalogDocument([base]));
    expect(Object.keys(j)).toEqual(['data']);
    expect(j.data).toHaveLength(1);
    expect(j.data[0].id).toBe('qwen3.8:27b');
  });
});
