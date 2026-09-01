import { describe, it, expect } from 'vitest';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  REASSIGN_AUTH_TYPES, authDomain, ANY_PROVIDER, toWire, isLive,
  DEFAULT_MAX_REASSIGNS, signReassignAuth,
} from '../reassign-auth';

// The same fixed inputs as contracts/test/DinnerNodeV2AuthVector.t.sol. If
// either side's encoding drifts, one of the two tests fails. Without this the
// failure mode is silent and nocturnal: every signature the guest gives is
// valid, and every handover that tries to use one reverts with "bad auth".
const VECTOR = {
  chainId: 10143,
  verifyingContract: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f' as const,
  jobId: 42n,
  newProvider: ANY_PROVIDER,
  maxReassigns: 2n,
  deadline: 1788000000n,
  digest: '0x72f3db480532f6bf9bbad04b1434a71ac2c8929c5e44742f44caa9197f6942f2' as const,
};

describe('reassign auth', () => {
  it('produces the digest the contract produces', () => {
    const digest = hashTypedData({
      domain: authDomain(VECTOR.chainId, VECTOR.verifyingContract),
      types: REASSIGN_AUTH_TYPES,
      primaryType: 'ReassignAuth',
      message: {
        jobId: VECTOR.jobId,
        newProvider: VECTOR.newProvider,
        maxReassigns: VECTOR.maxReassigns,
        deadline: VECTOR.deadline,
      },
    });
    expect(digest).toBe(VECTOR.digest);
  });

  it('changes the digest when any field changes', () => {
    const base = {
      domain: authDomain(VECTOR.chainId, VECTOR.verifyingContract),
      types: REASSIGN_AUTH_TYPES,
      primaryType: 'ReassignAuth' as const,
      message: {
        jobId: VECTOR.jobId, newProvider: VECTOR.newProvider,
        maxReassigns: VECTOR.maxReassigns, deadline: VECTOR.deadline,
      },
    };
    const variants = [
      { ...base, message: { ...base.message, jobId: 43n } },
      { ...base, message: { ...base.message, maxReassigns: 3n } },
      { ...base, message: { ...base.message, deadline: VECTOR.deadline + 1n } },
      { ...base, message: { ...base.message, newProvider: '0x000000000000000000000000000000000000dEaD' as const } },
      { ...base, domain: authDomain(1, VECTOR.verifyingContract) },
      { ...base, domain: authDomain(VECTOR.chainId, '0x000000000000000000000000000000000000dEaD') },
    ];
    for (const v of variants) expect(hashTypedData(v as any)).not.toBe(VECTOR.digest);
  });

  it('signs with the guest key and recovers to the guest', async () => {
    const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    // A minimal stand-in for the wallet client: signTypedData is the only
    // thing signReassignAuth uses, and viem's local account implements it
    // with the same encoding an injected wallet would.
    const wallet = {
      account,
      signTypedData: (args: any) => account.signTypedData(args),
    } as any;

    const auth = await signReassignAuth(wallet, VECTOR.chainId, VECTOR.verifyingContract, 7n);
    expect(auth.newProvider).toBe(ANY_PROVIDER);
    expect(auth.maxReassigns).toBe(DEFAULT_MAX_REASSIGNS);

    const signer = await recoverTypedDataAddress({
      domain: authDomain(VECTOR.chainId, VECTOR.verifyingContract),
      types: REASSIGN_AUTH_TYPES,
      primaryType: 'ReassignAuth',
      message: {
        jobId: 7n, newProvider: auth.newProvider,
        maxReassigns: auth.maxReassigns, deadline: auth.deadline,
      },
      signature: auth.signature,
    });
    expect(signer).toBe(account.address);
  });

  it('gives an authorisation that expires', async () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = { jobId: 1n, newProvider: ANY_PROVIDER, maxReassigns: 2n, deadline: BigInt(now + 60), signature: '0x' as const };
    expect(isLive(auth, now)).toBe(true);
    expect(isLive(auth, now + 61)).toBe(false);
  });

  it('crosses JSON without losing precision', () => {
    const auth = {
      jobId: 2n ** 64n + 7n, newProvider: ANY_PROVIDER,
      maxReassigns: 2n, deadline: 1788000000n, signature: '0xabcd' as const,
    };
    const wire = JSON.parse(JSON.stringify(toWire(auth)));
    expect(wire.jobId).toBe('18446744073709551623');
    expect(BigInt(wire.jobId)).toBe(auth.jobId);
    expect(BigInt(wire.deadline)).toBe(auth.deadline);
  });
});
