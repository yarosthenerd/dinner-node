import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError } from 'viem';

/**
 * Did the chain say this call REVERTS, or did we merely fail to ask it?
 *
 * The distinction is the whole point. `gasFor` used to catch both and return a
 * padded fallback, and the caller then broadcast the transaction anyway. On
 * Monad, which charges the gas LIMIT rather than the gas used, that means a
 * call the chain had already refused to estimate was sent at its full padded
 * limit and burned all of it. The estimate had the answer and it was thrown
 * away.
 *
 * A revert is a verdict about the call: sending it cannot help. Anything else,
 * an unreachable RPC, a timeout, a rate limit, is a fault on our side of the
 * wire and is exactly what the fallback exists for, because a node that stops
 * settling every time a public endpoint has a bad minute is worse than one
 * that occasionally overpays for gas.
 *
 * Both the typed path and the string are checked. viem wraps a revert as
 * `ContractFunctionRevertedError` or `ExecutionRevertedError` inside a
 * `BaseError`, which is the reliable signal; the string is the backstop for a
 * node returning `execution reverted` as a plain JSON-RPC error, which the
 * public Monad endpoint has been seen to do.
 */
export function isRevert(e: unknown): boolean {
  if (e instanceof BaseError) {
    const found = e.walk(err =>
      err instanceof ContractFunctionRevertedError || err instanceof ExecutionRevertedError);
    if (found) return true;
  }
  const msg = String((e as any)?.shortMessage ?? (e as any)?.message ?? e ?? '').toLowerCase();
  // `execution reverted`, `call reverted`, and the bare `reverted` some nodes
  // return. Deliberately NOT a bare match on "revert", which appears in
  // perfectly ordinary text such as "reverting to the fallback".
  return /execution reverted|call reverted|reverted with|^reverted\b|\breverted:/.test(msg);
}

/** Thrown by `gasFor` when the chain has already said the call cannot succeed. */
export class WillRevert extends Error {
  constructor(fn: string, detail: string) {
    super(`${fn} would revert, so it was not sent: ${detail}`);
    this.name = 'WillRevert';
  }
}
