// The guest's wallet, which is either their own injected wallet or a burner.
//
// Why both exist. The burner key in lib.ts is what makes the demo openable by
// someone with no extension installed: it is generated in the browser, funded
// by the house faucet, and spends testnet MON nobody cares about. That is the
// right default for a reviewer clicking a link, and it is the wrong thing to
// claim in a pitch, because "the guest pays the provider" is not demonstrated
// when the house owns both ends of the transfer. An injected wallet closes
// that gap: the escrow, the deposit and the settlement are then value the
// guest brought and the house never touched.
//
// So this module keeps the burner as the fallback and treats a connected
// wallet as an upgrade over it, rather than replacing one with the other.
//
// Discovery is EIP-6963 rather than `window.ethereum`, because with more than
// one extension installed `window.ethereum` is whichever one won the race to
// assign it. The legacy object is still used as a last resort for wallets that
// never announce themselves.
import { createWalletClient, custom, type Account, type EIP1193Provider, type Transport, type WalletClient } from 'viem';
import { burnerAddress, burnerWallet, monadTestnet } from '../lib';

export const MONAD_CHAIN_ID = 10143;
const MONAD_CHAIN_HEX = '0x279f';
// Only the wallet the guest last used is reconnected without a prompt, and
// only through eth_accounts, which does not ask for permission it was not
// already given.
const LAST_WALLET_KEY = 'dn_wallet_rdns';

/// Both clients pinned to one type, with the chain and the account fixed and
/// only the transport free. Without the chain in the type viem cannot tell
/// that every write already knows which chain it is for, and demands an
/// explicit `chain` on every writeContract call at the call sites.
export type GuestWalletClient = WalletClient<Transport, typeof monadTestnet, Account>;

export type DiscoveredWallet = {
  rdns: string;
  name: string;
  icon: string;
  provider: EIP1193Provider;
};

export type WalletState = {
  /// 'burner' is the generated key in lib.ts; 'injected' is the guest's own.
  mode: 'burner' | 'injected';
  address: `0x${string}`;
  /// Always carries a bound account, so every call site can keep using
  /// writeContract without passing one, whichever mode is active.
  client: GuestWalletClient;
  /// Human label for the header. 'burner' or the wallet's announced name.
  label: string;
  /// False when an injected wallet is connected to some other chain. Reads go
  /// through the public client either way, so the app still works; writes are
  /// what break, and they break with a viem chain mismatch rather than by
  /// landing somewhere unintended.
  chainOk: boolean;
  wallets: DiscoveredWallet[];
  connecting: boolean;
  error: string | null;
};

const burnerState = (wallets: DiscoveredWallet[]): WalletState => ({
  mode: 'burner',
  address: burnerAddress,
  client: burnerWallet,
  label: 'burner',
  chainOk: true,
  wallets,
  connecting: false,
  error: null,
});

let state: WalletState = burnerState([]);
const listeners = new Set<() => void>();

/// Every mutation goes through here, because useSyncExternalStore compares
/// snapshots by reference: mutating `state` in place would render nothing.
function set(patch: Partial<WalletState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getSnapshot = () => state;

// ---------------------------------------------------------------- discovery

const found = new Map<string, DiscoveredWallet>();

function announce(e: Event) {
  const detail = (e as CustomEvent).detail as { info?: any; provider?: EIP1193Provider } | undefined;
  if (!detail?.info?.rdns || !detail.provider) return;
  found.set(detail.info.rdns, {
    rdns: detail.info.rdns,
    name: detail.info.name ?? detail.info.rdns,
    icon: detail.info.icon ?? '',
    provider: detail.provider,
  });
  set({ wallets: [...found.values()] });
}

/// Start listening and ask anyone already loaded to announce. Safe to call
/// more than once; the map is keyed by rdns.
export function discover() {
  if (typeof window === 'undefined') return;
  window.addEventListener('eip6963:announceProvider', announce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  // Legacy fallback. A wallet that both announces and sets window.ethereum is
  // deduplicated by rdns above, so this only ever adds one that did not.
  const legacy = (window as any).ethereum as EIP1193Provider | undefined;
  if (legacy && !found.has('legacy.injected')) {
    const already = [...found.values()].some(w => w.provider === legacy);
    if (!already) {
      found.set('legacy.injected', {
        rdns: 'legacy.injected',
        name: (legacy as any).isMetaMask ? 'MetaMask' : 'injected wallet',
        icon: '',
        provider: legacy,
      });
      set({ wallets: [...found.values()] });
    }
  }
}

// ------------------------------------------------------------------ network

async function currentChainId(provider: EIP1193Provider): Promise<number> {
  const hex = await provider.request({ method: 'eth_chainId' }) as string;
  return Number.parseInt(hex, 16);
}

/// Ask the wallet to move to Monad testnet, adding it first if the wallet has
/// never heard of it. Returns whether the wallet ended up on the right chain,
/// rather than throwing: a guest who declines the switch should see a button,
/// not a broken page.
export async function ensureChain(provider: EIP1193Provider): Promise<boolean> {
  try {
    if (await currentChainId(provider) === MONAD_CHAIN_ID) return true;
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: MONAD_CHAIN_HEX }],
    } as any);
    return await currentChainId(provider) === MONAD_CHAIN_ID;
  } catch (e: any) {
    // 4902 is "unrecognised chain". MetaMask also reports it nested inside a
    // -32603 on some versions, which is why the message is checked too.
    const unknown = e?.code === 4902 || e?.data?.originalError?.code === 4902
      || /unrecognized chain|unrecognised chain/i.test(e?.message ?? '');
    if (!unknown) return false;
    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: MONAD_CHAIN_HEX,
          chainName: 'Monad Testnet',
          nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
          rpcUrls: ['https://testnet-rpc.monad.xyz'],
          blockExplorerUrls: ['https://testnet.monadvision.com'],
        }],
      } as any);
      return await currentChainId(provider) === MONAD_CHAIN_ID;
    } catch { return false; }
  }
}

// ------------------------------------------------------------------ connect

let bound: EIP1193Provider | null = null;

/// Adopt an account the wallet has already granted. Shared by connect() and
/// the silent reconnect, so both produce identical state.
async function adopt(w: DiscoveredWallet, address: `0x${string}`) {
  const chainOk = await ensureChain(w.provider);
  const client = createWalletClient({
    account: address,
    chain: monadTestnet,
    transport: custom(w.provider),
  });
  bindEvents(w);
  try { localStorage.setItem(LAST_WALLET_KEY, w.rdns); } catch {}
  set({ mode: 'injected', address, client, label: w.name, chainOk, connecting: false, error: null });
}

function bindEvents(w: DiscoveredWallet) {
  if (bound === w.provider) return;
  bound = w.provider;
  const p = w.provider as any;
  p.on?.('accountsChanged', (accounts: string[]) => {
    // An empty array is the wallet revoking this site, which is the same
    // instruction as pressing disconnect.
    if (!accounts.length) { disconnect(); return; }
    void adopt(w, accounts[0] as `0x${string}`);
  });
  p.on?.('chainChanged', (hex: string) => {
    set({ chainOk: Number.parseInt(hex, 16) === MONAD_CHAIN_ID });
  });
}

/// Prompt the guest to connect. `rdns` picks one of the discovered wallets;
/// with none given the first discovered wallet is used, which is the common
/// case of exactly one extension installed.
export async function connect(rdns?: string): Promise<void> {
  discover();
  const w = rdns ? found.get(rdns) : [...found.values()][0];
  if (!w) {
    set({ error: 'no browser wallet found. install MetaMask, or keep using the burner.' });
    return;
  }
  set({ connecting: true, error: null });
  try {
    const accounts = await w.provider.request({ method: 'eth_requestAccounts' }) as string[];
    if (!accounts?.length) throw new Error('the wallet returned no accounts');
    await adopt(w, accounts[0] as `0x${string}`);
  } catch (e: any) {
    // 4001 is the guest pressing reject, which is a decision rather than a
    // fault, so it does not get an error banner.
    set({
      connecting: false,
      error: e?.code === 4001 ? null : (e?.shortMessage ?? e?.message ?? 'could not connect the wallet'),
    });
  }
}

/// Drop back to the burner. This does not revoke anything in the wallet
/// itself, which no dapp can do; it stops this page using it.
export function disconnect() {
  try { localStorage.removeItem(LAST_WALLET_KEY); } catch {}
  bound = null;
  set({ ...burnerState([...found.values()]) });
}

/// Reconnect without a prompt if the guest connected before. eth_accounts
/// returns empty rather than asking, so a guest who never connected, or who
/// revoked the site in their wallet, is left on the burner.
export async function restore(): Promise<void> {
  discover();
  let rdns: string | null = null;
  try { rdns = localStorage.getItem(LAST_WALLET_KEY); } catch {}
  if (!rdns) return;
  // A wallet that announces late would not be in the map yet.
  const w = found.get(rdns) ?? await new Promise<DiscoveredWallet | undefined>(res => {
    setTimeout(() => res(found.get(rdns!)), 300);
  });
  if (!w) return;
  try {
    const accounts = await w.provider.request({ method: 'eth_accounts' }) as string[];
    if (accounts?.length) await adopt(w, accounts[0] as `0x${string}`);
  } catch { /* stay on the burner */ }
}

/// Ask a connected wallet to move to Monad testnet, for the header button that
/// appears when it is on the wrong chain.
export async function switchChain(): Promise<void> {
  if (state.mode !== 'injected' || !bound) return;
  set({ chainOk: await ensureChain(bound) });
}

// -------------------------------------------------------------------- react

import { useEffect, useSyncExternalStore } from 'react';

/// The current wallet, re-rendering the component when the guest connects,
/// disconnects, switches account or switches network.
export function useWallet(): WalletState {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => { void restore(); }, []);
  return s;
}
