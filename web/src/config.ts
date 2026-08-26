export const ADDR = '0xaF2c9E9080c6C8232E2630d05e5FfC1082c83A92' as `0x${string}`;
export const ZK = '0x1D6fE5F98A9b0cE6415925859DFF4dd624CFc8A0' as `0x${string}`;

// Discovery listener (src/discovery.ts). Primary source for who is online.
// Empty string disables it and the app falls back to the known list below.
export const DISCOVERY = (import.meta as any).env?.VITE_DISCOVERY_URL ?? '';

// Fallback only, used when discovery is unreachable. These are read straight
// from providers(addr) on chain, so a stale entry shows as inactive rather
// than as a phantom node. The two pre-rotation addresses were removed: they
// are retired per HANDOFF section 3 and were the reason this list described
// nobody who was actually serving.
export const KNOWN_PROVIDERS = [
  '0x055a2e24f4588915aB133Cb85753b0E4BBBC326A',
] as `0x${string}`[];
