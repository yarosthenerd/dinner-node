# DinnerNode — Project Context Handoff

Resume instruction: treat this file as full project memory. User = yaros (Belgrade,
Serbia). Project won 1st place at the Monad x Port hackathon ($1,000). Next step:
Delta V accelerator application.

## 1. What it is
DinnerNode: decentralized marketplace where idle consumer PCs rent their hardware
for local LLM inference; guests pay per token; settlements stream on-chain every
few seconds on Monad testnet. Tagline: "your idle PC pays for dinner." /
"every token is a tip."

## 2. Links and addresses
- Chain: Monad testnet, chainId 10143, RPC https://testnet-rpc.monad.xyz,
  explorer https://testnet.monadvision.com
- Contract DinnerNode (registry+escrow): 0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92
- Contract DinnerZK (deployed, currently UNUSED, reserved): address in .env as ZK=
- Web app (Vercel): https://web-opal-sigma-55.vercel.app
  - /slides.html and /DinnerNode_pitch.pptx served from web/public
  - cloud kitchen API: /api/p/health, /api/p/job (mock inference, REAL settlements)
- Tunnel (permanent): https://litter-unfunded-improvise.ngrok-free.dev -> :4173
- GitHub: https://github.com/yarosthenerd/dinner-node
- Hardware: ROG Strix G18 laptop, RTX 5070 Ti Laptop GPU, 24 cores, 33GB RAM,
  LAN 192.168.50.106; model ollama qwen3.8:27b

## 3. Wallets (SECRETS WERE EXPOSED IN CHAT: rotate after demo season)
- Provider: 0xEAdCAED4b65660475E8e7bfb8deae1FFBABE61AB (key: PROVIDER_PK in .env)
- House/cloud-kitchen: 0xb2bA4914cd0b2F5FE36B58d861274051e83032fC
  (key embedded in web/api/p/_lib.js; backup HOUSE_PK= in .env; old key in Vercel
  env is stale, ignore it)
- Guest (frontend, per-browser): 0x5922...01a0 example; generated in web/src/lib.ts

## 4. Repo map
- contracts/src/DinnerNode.sol: registerProvider(model,hw,rate), deposit(),
  openJob(provider,budget,tagBytes32), settle(jobId,delta), closeJob, withdraw,
  refund. State: providers(addr)[model,hw,rate,earned,tokensServed,jobsDone,active],
  jobs(id)[requester,provider,escrow,paid,tokens,open], deposits(addr), jobCounter.
  Events: ProviderRegistered, JobOpened, StreamSettled(jobId,tokensDelta,amount),
  JobClosed.
- contracts/src/DinnerZK.sol: nullifier registry (join/rate). Not wired to UI.
- src/host.ts: provider daemon. Endpoints /, /health, /job (SSE), /lanjob
  (self-opened job for LAN guests). Heartbeat SSE comment ": hb" every 1s.
  Settlement interval 3s. Explicit gas + maxFeePerGas cap 2000 gwei everywhere
  (settle 100k, close 120k, register 250k, openJob 250k, deposit 200k).
  Engine pick: LLM_BASE_URL (openai-compat) -> ollama (MODEL env, validated
  against installed tags, fallback to first tag) -> mock.
- src/guest.ts (CLI), src/engines.ts, src/chain.ts (viem clients, ABI, ADDR).
- web/: Vite React + Vercel. src/App.tsx dashboard; src/lib.ts guest wallet +
  faucet(); src/config.ts ADDR/EXPLORER/ZK.
- web/api/p/_lib.js + health.js + job.js: hosted cloud kitchen (house wallet).
- web/api/topup.js: house faucet endpoint (guest auto-topup on load if <5 MON,
  sessionStorage flag dn_topped; falls back to devnads drip).
- make_slides.py -> DinnerNode_pitch.pptx; slides.html; cover.html/cover.png;
  README.md.
- .env (root): PROVIDER_PK, DINNER_NODE_ADDRESS, MODEL=qwen3.8:27b, HOUSE_PK, ZK.

## 5. Web app behavior (current)
- Provider URL default = ngrok static domain; ?host= override; "cloud" button
  switches to same-origin /api/p.
- Prefilled prompt: "How much is the cost of an average dinner in Belgrade"
- place order: attempt() retry wrapper (8 tries, 1.5s) with progress notes
  ("warming the tunnel (n/8)..."); deposit 0.01 MON if needed (waits receipt
  BEFORE openJob: nonce collision fix); openJob tag = keccak(prompt + "|" +
  semaphore commitment); streams SSE with line buffering (chunk-split safe);
  markdown rendered via marked with autoscroll; if stream ends without
  [DONE], auto-failover: reopens job on cloud kitchen and finishes.
- Receipt ("the check") shows ONLY the live/latest job (dot while open);
  TOTAL = that job's paid.
- "your kitchen (sim)" card: fake hosting theater, labeled simulation.
- ZK: Semaphore identity in localStorage (dn_zk); after order success a Groth16
  proof is generated+verified in browser (singleton group) and flips the footer
  one-liner to "...groth16 proof verified in your browser...". Prompts on-chain
  only as keccak commitments. No on-chain Semaphore verifier yet (roadmap).
- Fetches send headers bypass-tunnel-reminder + ngrok-skip-browser-warning;
  host CORS allows both.

## 6. Economics (pitch numbers, all vetted)
- Belgrade dinner ~1,200 RSD ~ $11. Subscriptions $20-200/mo. 3B idle PCs,
  avg 8-16GB RAM.
- Earnings framing: avg PC ~$0.10/h -> dinner in ~110 idle hours; the RTX rig
  ~$0.60/h -> ~20 hours ("a weekend of sleep"). $1-3 per idle evening.
- Gas story: one answer ~30 settlements ~1.9M gas -> Ethereum ~$115 (20 gwei,
  $3k ETH) vs Monad ~$0.0003. Say "$115", never "$100+".
- On-chain rate RATE_PER_MILLION=2e18 is promotional; rates are provider-set.

## 7. Monad gas lessons (critical)
- Monad charges gas_limit, not gas_used -> always set tight explicit limits.
- Base fee "slow to rise, fast to fall": spikes to 1k-10k gwei drain wallets.
  maxFeePerGas cap 2000 gwei installed; if txs fail during a spike, STOP all
  txs ~4 min (fee falls), then resume.
- Faucets: devnads API (POST https://agents.devnads.com/v1/faucet,
  {"chainId":10143,"address":...}) now 1 MON per fresh address; sweep loop:
  create wallets, forward 0.8 each. faucet.monad.xyz captcha = real reserve.

## 8. Runbook
- T1: npm run host  (registers, serves; register failure is non-fatal if active)
- T2: ngrok http 4173 --url litter-unfunded-improvise.ngrok-free.dev
- Laptop: no sleep. Deploy: cd web && npm run build && vercel --prod --yes.
- Test matrix: laptop browser, phone on mobile data, LAN page
  http://192.168.50.106:4173.

## 9. Gotchas learned (do not repeat)
- Regex/split-join patching drifted repeatedly; prefer full-file rewrites for
  big changes; when patching, print MISS markers.
- Quoted heredocs ('EOF') for any file containing backslashes/backticks;
  unquoted only for deliberate $VAR expansion.
- SSE lines split across chunks: always buffer by newline.
- Send deposit and openJob sequentially (waitForTransactionReceipt) or nonce
  collision "An existing transaction had higher priority".
- Monad RPC getLogs range-capped: cascade spans (earliest, -50k, -20k, -5k,
  -1k) + per-job readContract fallback for the receipt.
- localtunnel flaky + interstitial; ngrok v3 static domain replaced it
  (equinox "stable" zip is ancient v2; use v3 URL).
- Ollama model tag must exist (qwen3.8:27b); wrong tag = zero-token jobs that
  close instantly.

## 10. Real vs mocked
Real: registry, escrow, settlements, laptop inference, ZK proofs, prompt
commitments, failover. Mocked: cloud kitchen inference (its settlements real),
sim hosting card (labeled). Discovery off-chain; indexer = roadmap.

## 11. Pitch package
- 4 slides: intro / problems (privacy, stalled hardware, subscriptions) /
  solution (per-second pay + $115 vs $0.0003) / clickable app link.
- Speech beats: 3B PCs, 8GB, $20-200, one-command node, live Belgrade question,
  fans audible, $11 answer, inflation joke optional, "every token is a tip."
- Say Monad by name. ZK one-liner: chain sees hash+payer, provider sees prompt
  only, ZK proof links neither to identity.

## 12. Roadmap
Semaphore on-chain verifier; Brevis ZK coprocessor; Phala TEE confidential
inference; zkML proof-of-inference; indexer/discovery; relayer or shielded
deposits for payer unlinking; x402/ERC-8004/EIP-7702 alignment.

## 13. User working preferences
- Complete paste-ready blocks; one block per goal; confirm-gated steps.
- Neutral professional language. NO punchy/rude tone. Apply anti-AI flags
  removal only where asked: zero em dashes, no "it's X, not Y" contrasts, no
  resumptive openers; keep register neutral.
- LinkedIn assets (About/headline/Experience) finalized neutral in prior chat.
