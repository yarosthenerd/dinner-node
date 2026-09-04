import { describe, expect, it } from 'vitest';
import {
  BaseError, ContractFunctionRevertedError, ExecutionRevertedError,
  HttpRequestError, TimeoutError,
} from 'viem';
import { isRevert, WillRevert } from '../revert';

describe('isRevert, which decides whether a transaction is worth sending', () => {
  it('is true for a contract revert, the typed shape viem actually throws', () => {
    const e = new BaseError('estimate failed', {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: 'settle', message: 'checkpoint must advance' }),
    });
    expect(isRevert(e)).toBe(true);
  });

  it('is true for an execution revert nested inside a wrapper', () => {
    // viem nests, and the walk has to find it rather than only look at the top.
    const e = new BaseError('outer', { cause: new BaseError('inner', { cause: new ExecutionRevertedError({}) }) });
    expect(isRevert(e)).toBe(true);
  });

  it('is true for a bare JSON-RPC string, which is what the public endpoint returns', () => {
    expect(isRevert(new Error('execution reverted'))).toBe(true);
    expect(isRevert(new Error('execution reverted: deposit more'))).toBe(true);
    expect(isRevert({ shortMessage: 'The contract function "settle" reverted with the following reason: closed' })).toBe(true);
  });

  it('is FALSE for an RPC that could not be reached, which is what the fallback is for', () => {
    // The distinction the whole module exists for. A node that stops settling
    // because a public endpoint had a bad minute is worse than one that
    // occasionally overpays for gas.
    expect(isRevert(new HttpRequestError({ url: 'https://testnet-rpc.monad.xyz', details: 'fetch failed' }))).toBe(false);
    expect(isRevert(new TimeoutError({ body: {}, url: 'https://testnet-rpc.monad.xyz' }))).toBe(false);
    expect(isRevert(new Error('ECONNREFUSED'))).toBe(false);
    expect(isRevert(new Error('429 Too Many Requests'))).toBe(false);
    expect(isRevert(new Error('eth_getLogs is limited to a 100 range'))).toBe(false);
  });

  it('does not match the word revert used in ordinary prose', () => {
    // A bare /revert/ would make "reverting to the fallback" look like a
    // verdict from the chain and stop the node settling on a healthy day.
    expect(isRevert(new Error('reverting to the fallback estimate'))).toBe(false);
    expect(isRevert(new Error('irreversible'))).toBe(false);
  });

  it('survives being handed nothing at all', () => {
    for (const x of [undefined, null, '', 0, {}]) expect(isRevert(x)).toBe(false);
  });
});

describe('WillRevert', () => {
  it('names the function and says the call was not sent', () => {
    const e = new WillRevert('settle', 'checkpoint must advance');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('WillRevert');
    expect(e.message).toBe('settle would revert, so it was not sent: checkpoint must advance');
  });
});
