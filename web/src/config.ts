export const ADDR = '0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92' as `0x${string}`;
// DinnerZK.sol is deployed at 0x1D6fE5F98A9b0cE6415925859DFF4dd624CFc8A0 and is
// not wired to anything. The Semaphore proof path was removed from App.tsx and
// the address is deliberately not exported: an export invites a claim the code
// does not support. Re-export it in the change that actually uses it.

// Discovery listener (src/discovery.ts). Primary source for who is online.
// Empty string disables it and the app falls back to the known list below.
export const DISCOVERY = (import.meta as any).env?.VITE_DISCOVERY_URL ?? '';

// Fallback only, used when discovery is unreachable. These are read straight
// from providers(addr) on chain, so a stale entry shows as inactive rather
// than as a phantom node. The two pre-rotation addresses were removed: they
// are retired per HANDOFF section 3 and were the reason this list described
// nobody who was actually serving.
export const KNOWN_PROVIDERS = [
  // The GPU node: qwen3.6:35b-a3b, priced from its own ten provider band.
  '0x055a2e24f4588915aB133Cb85753b0E4BBBC326A',
  // The small node: llama3.2:1b, its own key, its own model, and about a fifth
  // of the rate. Two models at two prices is what makes this a marketplace
  // rather than one machine with a price list, and the chain shows two
  // providers rather than one wearing two hats.
  '0x1978602dF1865eD61EA0754030817fD8F6A694d3',
] as `0x${string}`[];
