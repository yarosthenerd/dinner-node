// Monad charges the gas LIMIT rather than the gas used, so the number these
// tests are about is money the guest pays whether or not the call needs it.
// What is asserted here is the policy around the estimate, not viem's
// estimator: the pad, the payable case, what a revert does, and what an
// unreachable RPC does. Those are four different answers and getting the last
// two the same way round is the whole point.
import { describe, expect, it, vi } from 'vitest';
import { estimateGas } from '../../lib';

const ctx = (pub: unknown, extra: Record<string, unknown> = {}) => ({
  pub: pub as never,
  address: '0x7E98Cd3E2312e43F98E406477efA5C3EaCb3423c' as `0x${string}`,
  abi: [],
  fn: 'openJob',
  args: [],
  account: '0xCDd994F9f578895326634A3147fBa6738ea15411' as `0x${string}`,
  fallback: 300000n,
  ...extra,
});

describe('the gas limit a guest actually pays', () => {
  it('pads the estimate by 20% for state drift between estimating and landing', async () => {
    const pub = { estimateContractGas: vi.fn().mockResolvedValue(180498n) };
    // The live openJob estimate on 2026-09-10. 180,498 -> 216,597, still well
    // under the 300,000 that was hardcoded before.
    expect(await estimateGas(ctx(pub))).toBe(216597n);
  });

  it('beats the fixed limit it replaces, which is the entire point', async () => {
    const pub = { estimateContractGas: vi.fn().mockResolvedValue(34483n) };
    // deposit, measured live. 200,000 fixed against 41,379 estimated.
    const gas = await estimateGas(ctx(pub, { fn: 'deposit', fallback: 200000n }));
    expect(gas).toBe(41379n);
    expect(gas).toBeLessThan(200000n);
  });

  it('passes the value through, because a payable call without it reverts', async () => {
    const pub = { estimateContractGas: vi.fn().mockResolvedValue(34483n) };
    await estimateGas(ctx(pub, { fn: 'deposit', value: 1000n }));
    expect(pub.estimateContractGas.mock.calls[0][0]).toMatchObject({ value: 1000n });
  });

  it('omits value entirely for a non-payable call rather than sending zero', async () => {
    const pub = { estimateContractGas: vi.fn().mockResolvedValue(1n) };
    await estimateGas(ctx(pub));
    expect(pub.estimateContractGas.mock.calls[0][0]).not.toHaveProperty('value');
  });

  it('rethrows a revert instead of padding over it', async () => {
    // The chain has said this call cannot succeed. Falling back to the fixed
    // limit here would broadcast it anyway and pay the limit to be told again.
    const pub = {
      estimateContractGas: vi.fn().mockRejectedValue(
        Object.assign(new Error('x'), { shortMessage: 'execution reverted: job not open' }),
      ),
    };
    await expect(estimateGas(ctx(pub))).rejects.toThrow('x');
  });

  it('falls back when the estimator is merely unreachable', async () => {
    // Not the same thing as a revert: the call may be perfectly valid and the
    // RPC simply did not answer. Refusing to send would strand the guest.
    const pub = { estimateContractGas: vi.fn().mockRejectedValue(new Error('HTTP request failed')) };
    expect(await estimateGas(ctx(pub))).toBe(300000n);
  });

  it('falls back on a rate limit rather than treating it as impossible', async () => {
    const pub = { estimateContractGas: vi.fn().mockRejectedValue(new Error('429 Too Many Requests')) };
    expect(await estimateGas(ctx(pub))).toBe(300000n);
  });
});
