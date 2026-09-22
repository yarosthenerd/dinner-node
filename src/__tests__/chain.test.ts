/**
 * The chain module: the ABI, the two addresses, and `gasFor`.
 *
 * `gasFor` is the one with history. Monad charges the gas LIMIT rather than the
 * gas used, so a padded limit is money actually spent, and `47b123a` fixed the
 * case where an estimate that reverted was swallowed and the transaction
 * broadcast anyway at the fallback limit, paying the limit to be told again.
 * Both of those are asserted here, along with the payable-value case that
 * silently returned the fallback for every deposit.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { encodeAbiParameters, encodeEventTopics } from 'viem';

const estimateContractGas = vi.fn();
const waitForTransactionReceipt = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    // The clients are built at import time, so they have to be replaced before
    // the module body runs. Everything else in viem stays real, including
    // parseAbi and parseEventLogs, because those are what the assertions below
    // are actually checking.
    createPublicClient: () => ({ estimateContractGas, waitForTransactionReceipt }),
    createWalletClient: (cfg: unknown) => ({ cfg }),
  };
});

const { ABI, DEFAULT_ADDR, V1_ADDR, EXPLORER, monadTestnet, gasFor, jobIdFromReceipt } =
  await import('../chain');
const { WillRevert } = await import('../revert');

const ACCOUNT = '0x055a2e24f4588915aB133Cb85753b0E4BBBC326A' as const;

beforeEach(() => {
  estimateContractGas.mockReset();
  waitForTransactionReceipt.mockReset();
});

describe('the deployed addresses', () => {
  it('defaults to DinnerNodeV2 and keeps V1 reachable under its own name', () => {
    // These two are quoted in the README, the terms page and the handoff. A
    // change here is a change to published fact, so it should break a test.
    expect(DEFAULT_ADDR).toBe('0xcf642a144f3cb1159b05563506698fc2db375029');
    expect(V1_ADDR).toBe('0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92');
    expect(DEFAULT_ADDR).not.toBe(V1_ADDR);
    expect(EXPLORER).toBe('https://testnet.monadvision.com');
  });
});

describe('the chain definition', () => {
  it('is Monad testnet with an 18 decimal native token', () => {
    expect(monadTestnet.id).toBe(10143);
    expect(monadTestnet.nativeCurrency.symbol).toBe('MON');
    expect(monadTestnet.nativeCurrency.decimals).toBe(18);
    expect(monadTestnet.rpcUrls.default.http[0]).toBe('https://testnet-rpc.monad.xyz');
  });

  it('does not resolve to chain id 0 or an empty endpoint', () => {
    // The `||` rather than `??` case: a bare `CHAIN_ID=` line in .env is an
    // empty string, and Number('') is 0. Every transaction from this process
    // would then be signed for the wrong chain.
    expect(monadTestnet.id).toBeGreaterThan(0);
    expect(monadTestnet.rpcUrls.default.http[0]).not.toBe('');
  });
});

describe('the ABI', () => {
  const named = (name: string) => ABI.filter(e => 'name' in e && e.name === name);

  it('declares exactly one settle, the five-argument form', () => {
    // v2 also has a two-argument convenience overload. Naming both here makes
    // viem disambiguate by argument shape, which turns every settle call into a
    // guess.
    const settles = named('settle');
    expect(settles).toHaveLength(1);
    expect((settles[0] as unknown as { inputs: unknown[] }).inputs).toHaveLength(5);
  });

  it('reads jobs and providers through the struct getters', () => {
    expect(named('getJob')).toHaveLength(1);
    expect(named('getProvider')).toHaveLength(1);
    // `jobs(uint256)` and `providers(address)` are the positional reads that
    // item 1.13 was about. They are deliberately absent.
    expect(named('jobs')).toHaveLength(0);
    expect(named('providers')).toHaveLength(0);
  });

  it('carries both reassign routes and the checkpoint writes', () => {
    expect(named('reassign')).toHaveLength(1);
    expect(named('reassignWithAuth')).toHaveLength(1);
    expect(named('commitCheckpoint')).toHaveLength(1);
    expect(named('getCheckpoint')).toHaveLength(1);
  });

  it('declares the events the indexer and the receipt parser read', () => {
    for (const e of ['JobOpened', 'StreamSettled', 'CheckpointCommitted', 'JobReassigned', 'ProviderRegistered']) {
      expect(ABI.some(x => x.type === 'event' && 'name' in x && x.name === e)).toBe(true);
    }
  });
});

describe('gasFor', () => {
  it('pads the estimate by 20 percent rather than using a fixed limit', async () => {
    estimateContractGas.mockResolvedValue(100000n);
    // 34,483 estimated against the 200,000 that used to be hardcoded is the
    // measured case; the pad absorbs state drift between estimating and landing.
    expect(await gasFor('deposit', [], ACCOUNT, 200000n)).toBe(120000n);
  });

  it('rounds the pad down rather than producing a fraction', async () => {
    estimateContractGas.mockResolvedValue(7n);
    expect(await gasFor('deposit', [], ACCOUNT, 200000n)).toBe(8n);
  });

  it('passes value through for a payable call', async () => {
    estimateContractGas.mockResolvedValue(1000n);
    await gasFor('deposit', [], ACCOUNT, 200000n, 500n);
    const [args] = estimateContractGas.mock.calls[0] as [Record<string, unknown>];
    // Estimating a payable call without its value reverts on the balance check,
    // which used to return the padded fallback for every deposit.
    expect(args.value).toBe(500n);
  });

  it('omits value entirely for a non-payable call', async () => {
    estimateContractGas.mockResolvedValue(1000n);
    await gasFor('closeJob', [1n], ACCOUNT, 200000n);
    const [args] = estimateContractGas.mock.calls[0] as [Record<string, unknown>];
    expect('value' in args).toBe(false);
  });

  it('throws WillRevert rather than broadcasting a call the chain refused', async () => {
    estimateContractGas.mockRejectedValue(
      Object.assign(new Error('execution reverted: job not open'), {
        shortMessage: 'execution reverted: job not open',
        name: 'ContractFunctionRevertedError',
      }),
    );
    await expect(gasFor('settle', [1n], ACCOUNT, 300000n)).rejects.toBeInstanceOf(WillRevert);
  });

  it('names the function and keeps the reason on the WillRevert', async () => {
    estimateContractGas.mockRejectedValue(
      Object.assign(new Error('execution reverted: not your job'), {
        shortMessage: 'execution reverted: not your job',
        name: 'ContractFunctionRevertedError',
      }),
    );
    const err = await gasFor('settle', [1n], ACCOUNT, 300000n).catch(e => e);
    expect(err).toBeInstanceOf(WillRevert);
    expect(String(err.message)).toContain('settle');
    expect(String(err.message)).toContain('not your job');
  });

  it('falls back to the fixed limit when estimation fails for a non-revert reason', async () => {
    // An RPC timeout is not the chain refusing the call, so the write should
    // still go out rather than be abandoned.
    estimateContractGas.mockRejectedValue(new Error('fetch failed'));
    expect(await gasFor('deposit', [], ACCOUNT, 200000n)).toBe(200000n);
  });
});

describe('jobIdFromReceipt', () => {
  const GUEST = '0x000000000000000000000000000000000000cafe' as const;

  /** A JobOpened log encoded exactly as the chain returns one. */
  const opened = (jobId: bigint) => {
    const ev = ABI.find(e => e.type === 'event' && 'name' in e && e.name === 'JobOpened')!;
    return {
      address: DEFAULT_ADDR,
      topics: encodeEventTopics({
        abi: [ev],
        eventName: 'JobOpened',
        args: { jobId, requester: GUEST, provider: ACCOUNT },
      }),
      data: encodeAbiParameters([{ type: 'string' }], ['salted-tag']),
    };
  };

  it('reads the id off the JobOpened log', async () => {
    waitForTransactionReceipt.mockResolvedValue({ logs: [opened(12n)] });
    expect(await jobIdFromReceipt('0xdead' as `0x${string}`)).toBe(12n);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: '0xdead' });
  });

  it('picks JobOpened out of a receipt carrying other events', async () => {
    // A deposit in the same transaction, or any unrelated log, must not be
    // mistaken for the one being looked for.
    const noise = { address: DEFAULT_ADDR, topics: ['0x' + '11'.repeat(32)], data: '0x' };
    waitForTransactionReceipt.mockResolvedValue({ logs: [noise, opened(99n)] });
    expect(await jobIdFromReceipt('0xdead' as `0x${string}`)).toBe(99n);
  });

  it('does not silently return a job id when the receipt has no JobOpened', async () => {
    // Returning undefined here would open a job the caller then settles against
    // id `undefined`, so throwing is the correct failure.
    waitForTransactionReceipt.mockResolvedValue({ logs: [] });
    await expect(jobIdFromReceipt('0xdead' as `0x${string}`)).rejects.toBeTruthy();
  });
});
