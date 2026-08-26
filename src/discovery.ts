import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getAddress, isAddress } from 'viem';
import { ABI, ADDR, pub } from './chain';

const PORT = Number(process.env.DISCOVERY_PORT ?? 4174);
const REFRESH_MS = Number(process.env.DISCOVERY_REFRESH_MS ?? 15000);
const ANNOUNCE_TTL_MS = Number(process.env.DISCOVERY_TTL_MS ?? 10 * 60 * 1000);
const CACHE = path.resolve(process.cwd(), '.discovery-cache.json');

// The public Monad RPC rejects any eth_getLogs wider than 100 blocks
// ("eth_getLogs is limited to a 100 range", code -32614). At roughly half a
// second per block that is about 40 seconds of history, so scanning backwards
// for past registrations is not available on this endpoint. Discovery is
// therefore built on three sources that do work:
//   1. a persisted cache of addresses we have already seen,
//   2. POST /announce from a running provider, verified against the registry,
//   3. a rolling forward tail scan that catches new registrations as they land.
// Every address, whatever its source, is confirmed with a providers(addr) read
// before it is served. The event is a claim; the mapping is the truth.
const MAX_RANGE = 99n;
const CHUNKS_PER_REFRESH = Number(process.env.DISCOVERY_CHUNKS ?? 6);

export type ProviderEntry = {
  address: `0x${string}`;
  model: string;
  hw: string;
  ratePerMillion: string;
  earned: string;
  tokensServed: string;
  jobsDone: string;
  active: boolean;
  url: string | null;
  source: 'cache' | 'seed' | 'chain' | 'announce';
  lastSeen: number;
};

const table = new Map<string, ProviderEntry>();
const known = new Set<string>();
let cursor: bigint | null = null;

function loadCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    for (const a of j.known ?? []) if (isAddress(a)) known.add(getAddress(a).toLowerCase());
    if (j.cursor) cursor = BigInt(j.cursor);
  } catch {}
  for (const a of (process.env.DISCOVERY_SEED ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (isAddress(a)) known.add(getAddress(a).toLowerCase());
  }
}
function saveCache() {
  try {
    fs.writeFileSync(CACHE, JSON.stringify({ known: [...known], cursor: cursor ? String(cursor) : null }, null, 2));
  } catch {}
}

async function verify(address: `0x${string}`) {
  try {
    const p = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'providers', args: [address] }) as unknown as any[];
    if (!p[6]) return null;
    return {
      address,
      model: String(p[0]),
      hw: String(p[1]),
      ratePerMillion: String(p[2]),
      earned: String(p[3]),
      tokensServed: String(p[4]),
      jobsDone: String(p[5]),
      active: true as const,
    };
  } catch {
    return null;
  }
}

const REG_EVENT = ABI.find(a => (a as any).type === 'event' && (a as any).name === 'ProviderRegistered') as any;

// Guards overlapping refreshes. Two concurrent scans share `cursor` and would
// each advance it, so half the windows would be scanned twice and half skipped.
let scanning = false;

async function tailScan() {
  if (scanning) return;
  scanning = true;
  try {
    const head = await pub.getBlockNumber();
    // A local, so the compiler can see it is a bigint throughout. `cursor` is
    // bigint | null and the null check did not narrow through the loop.
    let at: bigint = cursor ?? (head > MAX_RANGE ? head - MAX_RANGE : 0n);
    let chunks = 0;

    while (at < head && chunks < CHUNKS_PER_REFRESH) {
      const from = at;
      const to = from + MAX_RANGE > head ? head : from + MAX_RANGE;
      try {
        const logs = await pub.getLogs({ address: ADDR, event: REG_EVENT, fromBlock: from, toBlock: to });
        for (const l of logs) {
          const a = (l as any).args?.provider as `0x${string}` | undefined;
          if (a) known.add(getAddress(a).toLowerCase());
        }
      } catch {
        // Do NOT advance past a window that failed. Advancing meant a single
        // transient RPC error silently and permanently lost every registration
        // in that window. Stop here and retry the same window on the next
        // refresh; the catch-up below stops a persistently bad window from
        // stalling the tail forever.
        break;
      }
      at = to + 1n;
      chunks++;
    }

    // If we have fallen far behind the head, skip forward. Staying current
    // matters more than a complete history we cannot obtain from this RPC anyway.
    if (head - at > MAX_RANGE * BigInt(CHUNKS_PER_REFRESH) * 20n) at = head - MAX_RANGE;
    cursor = at;
  } finally {
    scanning = false;
  }
}

async function refresh() {
  await tailScan().catch(() => {});
  for (const key of [...known]) {
    const v = await verify(getAddress(key) as `0x${string}`);
    if (!v) { table.delete(key); continue; }
    const prev = table.get(key);
    table.set(key, {
      ...v,
      url: prev?.url ?? null,
      source: prev?.source ?? 'cache',
      lastSeen: prev?.lastSeen ?? Date.now(),
    });
  }
  for (const [key, e] of table) {
    if (e.source === 'announce' && Date.now() - e.lastSeen > ANNOUNCE_TTL_MS) table.set(key, { ...e, url: null, source: 'chain' });
  }
  saveCache();
  const reachable = [...table.values()].filter(e => e.url).length;
  console.log(`[discovery] known=${known.size} active=${table.size} reachable=${reachable} cursor=${cursor}`);
}

function list() {
  return [...table.values()]
    .filter(e => e.active)
    .sort((a, b) => (b.url ? 1 : 0) - (a.url ? 1 : 0) || Number(BigInt(b.tokensServed) - BigInt(a.tokensServed)));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, bypass-tunnel-reminder, ngrok-skip-browser-warning');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  if (req.method === 'GET' && (req.url === '/providers' || req.url === '/')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ updated: Date.now(), providers: list() }));
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: true, known: known.size, active: table.size, registry: ADDR, cursor: cursor ? String(cursor) : null, port: PORT }));
  }

  if (req.method === 'POST' && req.url === '/announce') {
    let body = '';
    let over = false;
    req.on('data', c => {
      if (over) return;
      body += c;
      if (body.length > 4096) { over = true; res.statusCode = 413; res.end('announce too large'); req.destroy(); }
    });
    req.on('end', async () => {
      if (over) return;
      try {
        const { address, url, model } = JSON.parse(body || '{}');
        if (!isAddress(String(address))) { res.statusCode = 400; return res.end('bad address'); }
        const a = getAddress(String(address));
        const v = await verify(a);
        if (!v) { res.statusCode = 403; return res.end('not an active on-chain provider'); }
        let clean: string | null = null;
        if (url) {
          const u = new URL(String(url));
          if (u.protocol !== 'http:' && u.protocol !== 'https:') { res.statusCode = 400; return res.end('bad url scheme'); }
          clean = u.origin;
        }
        known.add(a.toLowerCase());
        table.set(a.toLowerCase(), { ...v, model: model ? String(model).slice(0, 80) : v.model, url: clean, source: 'announce', lastSeen: Date.now() });
        saveCache();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, address: a, url: clean }));
      } catch (e: any) {
        res.statusCode = 400;
        res.end(String(e?.message ?? e));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end();
});

loadCache();
server.listen(PORT, async () => {
  console.log(`[discovery] listening on :${PORT} (registry ${ADDR}, ${known.size} cached)`);
  await refresh().catch(e => console.log('[discovery] first refresh failed:', e?.shortMessage ?? e));
  setInterval(() => { refresh().catch(e => console.log('[discovery] refresh failed:', e?.shortMessage ?? e)); }, REFRESH_MS);
});
