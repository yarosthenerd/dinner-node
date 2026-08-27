// What these cover is the state machine, not viem: whether the app ends up on
// the guest's wallet or on the burner, and what it does when the wallet says
// no. Every one of these paths ends in real MON moving from one address or
// the other, so "which wallet is this" is worth asserting rather than
// assuming.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MONAD_HEX = '0x279f';
const ACCOUNT = '0x1111111111111111111111111111111111111111';

type Handler = (...args: any[]) => void;

/// A stand-in for an injected provider, scripted per test. `calls` records the
/// method names in order, which is how the chain-switch assertions are made.
function fakeProvider(opts: {
  accounts?: string[];
  chainId?: string;
  requestAccountsError?: any;
  switchError?: any;
  addError?: any;
} = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  let chainId = opts.chainId ?? MONAD_HEX;
  const provider: any = {
    calls,
    emit: (event: string, ...args: any[]) => handlers.get(event)?.(...args),
    setChain: (id: string) => { chainId = id; },
    on: (event: string, h: Handler) => { handlers.set(event, h); },
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      switch (method) {
        case 'eth_chainId': return chainId;
        case 'eth_accounts': return opts.accounts ?? [];
        case 'eth_requestAccounts':
          if (opts.requestAccountsError) throw opts.requestAccountsError;
          return opts.accounts ?? [ACCOUNT];
        case 'wallet_switchEthereumChain':
          if (opts.switchError) throw opts.switchError;
          chainId = MONAD_HEX;
          return null;
        case 'wallet_addEthereumChain':
          if (opts.addError) throw opts.addError;
          chainId = MONAD_HEX;
          return null;
        default: throw new Error('unexpected method ' + method);
      }
    },
  };
  return provider;
}

function announce(provider: any, rdns = 'io.metamask', name = 'MetaMask') {
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
    detail: { info: { uuid: rdns, rdns, name, icon: '' }, provider },
  }));
}

/// Module state is a singleton by design, so every test gets a fresh copy of
/// the module rather than trying to unwind the previous one.
async function freshModule() {
  vi.resetModules();
  return import('../wallet');
}

beforeEach(() => {
  localStorage.clear();
  delete (window as any).ethereum;
});

describe('wallet', () => {
  it('starts on the burner, with a bound account', async () => {
    const w = await freshModule();
    const s = w.getSnapshot();
    expect(s.mode).toBe('burner');
    expect(s.label).toBe('burner');
    expect(s.chainOk).toBe(true);
    expect(s.client.account?.address).toBe(s.address);
  });

  it('discovers an announced wallet without connecting to it', async () => {
    const w = await freshModule();
    const p = fakeProvider();
    w.discover();
    announce(p);
    expect(w.getSnapshot().wallets.map(x => x.name)).toEqual(['MetaMask']);
    // Discovery is not connection: nothing was asked of the provider and the
    // guest is still spending the burner.
    expect(p.calls).toEqual([]);
    expect(w.getSnapshot().mode).toBe('burner');
  });

  it('falls back to window.ethereum for a wallet that never announces', async () => {
    const w = await freshModule();
    (window as any).ethereum = fakeProvider();
    w.discover();
    expect(w.getSnapshot().wallets).toHaveLength(1);
    expect(w.getSnapshot().wallets[0].rdns).toBe('legacy.injected');
  });

  it('connect switches the app to the guest wallet', async () => {
    const w = await freshModule();
    const p = fakeProvider({ accounts: [ACCOUNT] });
    w.discover();
    announce(p);
    await w.connect('io.metamask');
    const s = w.getSnapshot();
    expect(s.mode).toBe('injected');
    expect(s.address).toBe(ACCOUNT);
    expect(s.label).toBe('MetaMask');
    expect(s.chainOk).toBe(true);
    expect(s.client.account?.address).toBe(ACCOUNT);
    expect(localStorage.getItem('dn_wallet_rdns')).toBe('io.metamask');
  });

  it('asks a wallet on another chain to switch', async () => {
    const w = await freshModule();
    const p = fakeProvider({ accounts: [ACCOUNT], chainId: '0x1' });
    w.discover();
    announce(p);
    await w.connect('io.metamask');
    expect(p.calls).toContain('wallet_switchEthereumChain');
    expect(w.getSnapshot().chainOk).toBe(true);
  });

  it('adds Monad testnet when the wallet has never heard of it', async () => {
    const w = await freshModule();
    const p = fakeProvider({
      accounts: [ACCOUNT], chainId: '0x1',
      switchError: Object.assign(new Error('Unrecognized chain ID'), { code: 4902 }),
    });
    w.discover();
    announce(p);
    await w.connect('io.metamask');
    expect(p.calls).toContain('wallet_addEthereumChain');
    expect(w.getSnapshot().chainOk).toBe(true);
  });

  it('connects but flags the chain when the guest refuses to switch', async () => {
    const w = await freshModule();
    const p = fakeProvider({
      accounts: [ACCOUNT], chainId: '0x1',
      switchError: Object.assign(new Error('User rejected'), { code: 4001 }),
    });
    w.discover();
    announce(p);
    await w.connect('io.metamask');
    const s = w.getSnapshot();
    // Connected, on the wrong chain, and saying so. The app can still read;
    // it is writes that must not be attempted, which is what chainOk gates.
    expect(s.mode).toBe('injected');
    expect(s.chainOk).toBe(false);
  });

  it('treats a rejected connection as a decision, not an error', async () => {
    const w = await freshModule();
    const p = fakeProvider({ requestAccountsError: Object.assign(new Error('User rejected'), { code: 4001 }) });
    w.discover();
    announce(p);
    await w.connect('io.metamask');
    const s = w.getSnapshot();
    expect(s.mode).toBe('burner');
    expect(s.connecting).toBe(false);
    expect(s.error).toBeNull();
  });

  it('reports a connection failure that is not a rejection', async () => {
    const w = await freshModule();
    const p = fakeProvider({ requestAccountsError: new Error('wallet is locked') });
    w.discover();
    announce(p);
    await w.connect('io.metamask');
    expect(w.getSnapshot().error).toBe('wallet is locked');
    expect(w.getSnapshot().mode).toBe('burner');
  });

  it('says so rather than throwing when no wallet is installed', async () => {
    const w = await freshModule();
    await w.connect();
    expect(w.getSnapshot().mode).toBe('burner');
    expect(w.getSnapshot().error).toMatch(/no browser wallet/);
  });

  it('follows an account switch in the wallet', async () => {
    const w = await freshModule();
    const p = fakeProvider({ accounts: [ACCOUNT] });
    w.discover();
    announce(p);
    await w.connect('io.metamask');
    const next = '0x2222222222222222222222222222222222222222';
    p.emit('accountsChanged', [next]);
    await vi.waitFor(() => expect(w.getSnapshot().address).toBe(next));
    expect(w.getSnapshot().client.account?.address).toBe(next);
  });

  it('falls back to the burner when the wallet revokes the site', async () => {
    const w = await freshModule();
    const p = fakeProvider({ accounts: [ACCOUNT] });
    w.discover();
    announce(p);
    await w.connect('io.metamask');
    p.emit('accountsChanged', []);
    expect(w.getSnapshot().mode).toBe('burner');
    expect(localStorage.getItem('dn_wallet_rdns')).toBeNull();
  });

  it('flags the chain when the wallet is moved off Monad', async () => {
    const w = await freshModule();
    const p = fakeProvider({ accounts: [ACCOUNT] });
    w.discover();
    announce(p);
    await w.connect('io.metamask');
    p.emit('chainChanged', '0x1');
    expect(w.getSnapshot().chainOk).toBe(false);
    p.emit('chainChanged', MONAD_HEX);
    expect(w.getSnapshot().chainOk).toBe(true);
  });

  it('disconnect returns the app to the burner', async () => {
    const w = await freshModule();
    const p = fakeProvider({ accounts: [ACCOUNT] });
    w.discover();
    announce(p);
    await w.connect('io.metamask');
    const burner = (await import('../../lib')).burnerAddress;
    w.disconnect();
    expect(w.getSnapshot().mode).toBe('burner');
    expect(w.getSnapshot().address).toBe(burner);
  });

  it('restores a previous connection without prompting', async () => {
    localStorage.setItem('dn_wallet_rdns', 'io.metamask');
    const w = await freshModule();
    const p = fakeProvider({ accounts: [ACCOUNT] });
    w.discover();
    announce(p);
    await w.restore();
    expect(w.getSnapshot().mode).toBe('injected');
    // eth_accounts, never eth_requestAccounts: a page load must not open a
    // wallet popup for a guest who is only reading.
    expect(p.calls).toContain('eth_accounts');
    expect(p.calls).not.toContain('eth_requestAccounts');
  });

  it('stays on the burner when the wallet has revoked the site since', async () => {
    localStorage.setItem('dn_wallet_rdns', 'io.metamask');
    const w = await freshModule();
    const p = fakeProvider({ accounts: [] });
    w.discover();
    announce(p);
    await w.restore();
    expect(w.getSnapshot().mode).toBe('burner');
  });
});
