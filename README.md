# DinnerNode — your idle PC pays for dinner.

Rent idle consumer hardware to serve local LLM inference. Providers stream tokens;
requesters pay per token, **settled on Monad every ~2 seconds**.

**Live:** https://web-opal-sigma-55.vercel.app · **Contract:** [0xaF2c…3A92](https://testnet.monadvision.com/address/0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92) · Monad testnet (10143)

## Why Monad
One 60-second answer ≈ 30 settlement transactions. On Ethereum (20 gwei, $3k ETH) that's
≈ $60–200 of gas for a $0.002 answer. On Monad: fractions of a cent. Per-second post-pay
micropayments — the whole trust model — only exist on a 10k TPS, 400ms-block chain.

## Protocol (DinnerNode.sol)
`registerProvider(model, hw, rate)` → `deposit()` → `openJob(provider, budget, zkTag)` →
`settle(jobId, Δtokens)` @ ~2 Hz → `closeJob / withdraw / refund`.
Trust: post-pay per second; guest worst-case loss = one settlement; escrow exhaustion auto-closes.

## Privacy (zero-knowledge)
Prompts never touch the chain — only keccak commitments, bound per-job to a Semaphore
identity pseudonym. After each job a Groth16 proof is generated **and verified in the
guest's browser**. Roadmap: Semaphore on-chain verifier, Brevis ZK coprocessor,
Phala TEE confidential inference, zkML proof-of-inference.

Built with monskills on Monad testnet. *Every token is a tip.*
