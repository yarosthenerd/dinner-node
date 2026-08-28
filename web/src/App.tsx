import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { formatEther, keccak256, parseEther, parseEventLogs, toHex } from 'viem';
import { ABI, ADDR, EXPLORER, pub, faucet, fmt } from './lib';
import { useWallet, connect, disconnect, switchChain } from './lib/wallet';
import { isOursAndOpen, readJob, readProvider } from './lib/registry';
import { DISCOVERY, KNOWN_PROVIDERS } from './config';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
// Lazy on purpose. Semaphore's proving stack is about 450 kB and only a guest
// who actually rates ever needs it, so importing it eagerly would put that
// weight on every first paint for a feature most sessions never touch.
const ProviderRating = lazy(() => import('./components/ProviderRating'));
// Lazy for the same reason: a guest who only wants one answer should not pay
// for the plan UI in their first paint.
const PlanPanel = lazy(() => import('./components/PlanPanel'));
// Read straight from the environment rather than through lib/ratings, or the
// check itself would pull the module it is trying to defer.
const RATINGS_ON = !!import.meta.env.VITE_RATINGS_ADDRESS;
import { EngramSelector } from './components/EngramSelector';
import { initEngramSystem, preparePrompt, onJobOpen, onJobClose, applyPendingEngrams, resolvePendingEngrams, behavioralPreamble } from './lib/engram-integration';
import type { PendingEngrams } from './lib/engram-integration';

const short = (h: string) => h.slice(0, 6) + '…' + h.slice(-4);
const DEFAULT_HOST = 'https://litter-unfunded-improvise.ngrok-free.dev';
const TUNNEL_HEADERS = { 'bypass-tunnel-reminder': '1', 'ngrok-skip-browser-warning': 'true' };

// Monad's base fee is slow to rise and fast to fall, spiking to thousands of
// gwei, and the chain charges gas_limit rather than gas_used. Without this cap
// viem falls back to estimateFeesPerGas and a single openJob during a spike
// can commit several MON. The daemons already cap every write; the browser did
// not, which is where the guest's own wallet is spent.
const MAX_FEE = 2000000000000n;
// Coupled to TOPUP_AMOUNT and TOPUP_RECIPIENT_MAX in web/api/topup.js. See
// the funding invariant comment in the balance effect below before changing.
// Re-derived 2026-08-26 with the 0.30 MON escrow: a first order costs the guest
// 0.30 of escrow plus about 0.06 of gas, so the trigger has to clear 0.36.
// The invariant is unchanged and is what this number exists to satisfy: the
// trigger must clear the cost of one full order, or the app loops asking for a
// top-up it has already been given, and it must sit below TOPUP_RECIPIENT_MAX
// in web/api/topup.js, or the faucet refuses every request the app makes.
// Must clear the cost of one full order (1.00 escrow + ~0.06 gas) or a guest
// is left holding a balance that cannot open a job. Moved with the escrow
// raise that came with session jobs; see web/api/topup.js for the other two
// constants in this invariant.
const TOPUP_TRIGGER = parseEther('1.2');

// How many jobs back the receipt walks. Each one is a sequential eth_call, so
// this is a latency budget as much as a display choice, and it is the reason
// every total on the page is scoped to a window rather than to all time: the
// public Monad RPC caps eth_getLogs at 100 blocks, so there is no cheap way to
// read the full history from a browser. Every label that shows one of these
// numbers has to say so.
const FEED_WINDOW = 25n;

// Same four-characters-per-token rule the host uses, so the number shown here
// matches the number the host enforces instead of disagreeing with it.
const estTokens = (s: string) => Math.ceil(s.length / 4);

type Session = { ts: number; prompt: string; answer: string; jobId: string; cost: string };
const loadSessions = (): Session[] => {
  try { return JSON.parse(localStorage.getItem('dn_sessions') || '[]'); } catch { return []; }
};

// Fenced blocks become downloadable files. Markdown first, then whatever the
// fence is labelled with.
const EXT: Record<string, string> = { markdown: 'md', md: 'md', json: 'json', ts: 'ts', tsx: 'tsx', js: 'js', python: 'py', py: 'py', sh: 'sh', bash: 'sh', sol: 'sol', yaml: 'yml', yml: 'yml', html: 'html', css: 'css' };
function artifactsOf(text: string) {
  const out: { name: string; body: string }[] = [];
  const re = /```([A-Za-z0-9_+-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    const lang = (m[1] || 'md').toLowerCase();
    out.push({ name: `dinnernode-${++n}.${EXT[lang] ?? 'txt'}`, body: m[2] });
  }
  return out;
}

export default function App() {
  // The guest's wallet: their own if they connected one, otherwise the burner
  // key in lib.ts. Destructured under the old names so every call site below
  // reads the same as it did when there was only ever a burner. Each render
  // captures the wallet that was current when it ran, which is what an order
  // already in flight should keep using if the guest switches account
  // mid-answer.
  const wallet = useWallet();
  const { address: guestAddress, client: guestWallet } = wallet;
  const [providers, setProviders] = useState<any[]>([]);
  const [feed, setFeed] = useState<any[]>([]);
  const [total, setTotal] = useState(0n);
  const [jobs, setJobs] = useState(0n);
  const [bal, setBal] = useState(0n);
  const [sessionCost, setSessionCost] = useState(0n);
  const [url, setUrl] = useState(() => new URLSearchParams(window.location.search).get('host') || DEFAULT_HOST);
  const [prompt, setPrompt] = useState('How much is the cost of an average dinner in Belgrade?');
  const [stream, setStream] = useState('');
  // The model's reasoning, streamed as {th} frames. It IS billed, as output
  // tokens, the way every commercial provider bills it. It is held apart from
  // `stream` because it is still not part of the answer: it is not in the
  // checkpoint chain, and must not reach the markdown renderer or the saved
  // session. Showing it is what makes the charge honest, and it is also what
  // makes 15 to 47 seconds of silence look like a model working rather than a
  // dead node.
  const [thinking, setThinking] = useState('');
  /// Reasoning tokens BILLED, which is not derivable from `thinking`. One {th}
  /// frame is one billed token, and a frame's token boundaries are gone once
  /// the text is concatenated, so this counts frames as they arrive and then
  /// takes the node's own figure from the final frame. It used to be
  /// `thinking.length / 4`, which showed 836 on a stream that billed 920.
  const [thinkTokens, setThinkTokens] = useState(0);
  const [thinkOpen, setThinkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sanitization, setSanitization] = useState<'minimal' | 'balanced' | 'maximal'>('balanced');
  const [pendingEngrams, setPendingEngrams] = useState<PendingEngrams>({});
  const [note, setNote] = useState('');
  const [pulse, setPulse] = useState(0);
  const [sentPrompt, setSentPrompt] = useState('');
  const [budgetTokens, setBudgetTokens] = useState(30720);
  // What the selected host actually runs. /health has always carried `engine`
  // and nothing in the browser read it, so a guest could not tell a node
  // serving a real model from one serving canned text while settling real MON.
  const [hostEngine, setHostEngine] = useState<{ engine?: string; model?: string } | null>(null);
  // Whether the selected host executes plans, read from /health rather than
  // discovered from a 404 after a job is already open and paid for.
  const [hostPlans, setHostPlans] = useState(false);
  const [hostProvider, setHostProvider] = useState<`0x${string}` | null>(null);
  const [mode, setMode] = useState<'answer' | 'plan'>('answer');
  const [sessions, setSessions] = useState<Session[]>(loadSessions);
  // The provider this browser has actually paid. Ratings are gated on a paid
  // job by the contract, so there is nothing to show before the first one.
  const [ratedProvider, setRatedProvider] = useState<`0x${string}` | null>(null);
  const [canResume, setCanResume] = useState(false);
  const [discoveryUp, setDiscoveryUp] = useState<boolean | null>(null);
  // Whether the text on screen was produced by the hosted kitchen. The note
  // above the composer disclosed this only when the guest had SELECTED the
  // cloud endpoint, so an answer that failed over to it mid-order arrived as a
  // canned passage with nothing on the page saying it was one.
  const [servedByCloud, setServedByCloud] = useState(false);

  // The last checkpoint published by whichever provider was streaming. This is
  // what lets a replacement continue the same answer instead of starting over
  // and charging the guest twice for the same prefix.
  const cpRef = useRef<{ text: string; n: number; h: string } | null>(null);
  // The running answer, kept out of cpRef on purpose. cpRef.text must hold the
  // prefix the checkpoint hash actually covers, not everything received since.
  const liveRef = useRef('');
  const finalPromptRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const reloadRef = useRef<() => void>(() => {});
  // How long to wait for the provider's final settle before closing a job to
  // recover escrow. Published by the node as settleMaxMs, because the host no
  // longer settles on a fixed timer: it settles once the unsettled tokens are
  // worth more than the gas, with settleMaxMs as the backstop. A constant here
  // silently stopped matching the moment that cadence changed.
  const settleGraceRef = useRef(65000);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => { streamRef.current?.scrollTo(0, 999999); }, [stream]);
  useEffect(() => { initEngramSystem(); }, []);
  // Abort any in-flight stream if the component goes away mid-order.
  useEffect(() => () => { try { abortRef.current?.abort(); } catch {} }, []);

  // The behaviour preamble is prepended to the prompt that is actually sent
  // and is gated by the host's context check along with it, so it has to be
  // inside the number shown here. Counting the raw box alone understated the
  // request and let a guest over the host's budget press an enabled button.
  const preambleTokens = useMemo(
    () => estTokens(behavioralPreamble(resolvePendingEngrams(pendingEngrams))),
    [pendingEngrams],
  );
  const promptTokens = useMemo(() => estTokens(prompt) + preambleTokens, [prompt, preambleTokens]);
  const overBudget = promptTokens > budgetTokens;
  const artifacts = useMemo(() => artifactsOf(stream), [stream]);
  const renderedStream = useMemo(
    () => DOMPurify.sanitize(marked.parse(stream || '') as string),
    [stream],
  );
  // The hosted cloud kitchen is gone. It settled real MON for a fixed passage
  // of text, which was the one thing on this site that took payment for
  // nothing, and a network built on idle consumer GPUs falling back to a
  // serverless function undermined its own premise. Failover now goes to
  // another real node or nowhere. See SNAPSHOT 2026-08-27 (evening).
  const canned = false;

  // Provider discovery. The listener is primary; the on-chain read of the
  // known list is the fallback. Note that scanning ProviderRegistered logs is
  // NOT an option here: the public Monad RPC rejects any eth_getLogs wider
  // than 100 blocks, so there is no way to recover registration history from
  // the browser. Every entry below is confirmed with a providers(addr) read.
  async function loadProviders() {
    if (DISCOVERY) {
      try {
        const r = await fetch(DISCOVERY.replace(/\/$/, '') + '/providers', { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.providers)) {
            setDiscoveryUp(true);
            setProviders(j.providers.map((p: any) => ({
              p: p.address, model: p.model, hw: p.hw, url: p.url,
              earned: BigInt(p.earned), tokensServed: BigInt(p.tokensServed),
              jobsDone: BigInt(p.jobsDone), active: p.active,
            })));
            return;
          }
        }
      } catch (e) {
        // Worth surfacing: a plain http listener fetched from an https page is
        // blocked as mixed content, which otherwise looks like "offline".
        console.error('discovery fetch failed', e);
      }
      setDiscoveryUp(false);
    }
    const rows = await Promise.all(KNOWN_PROVIDERS.map(async a => {
      try {
        const pr = await readProvider(ADDR, a);
        return { p: a, model: pr.model, hw: pr.hw, url: null, earned: pr.earned,
                 tokensServed: pr.tokensServed, jobsDone: pr.jobs, active: pr.active };
      } catch { return null; }
    }));
    setProviders(rows.filter((x: any) => x && x.model && x.active));
  }

  useEffect(() => {
    let timer: any = null, un: any = null;
    const load = async () => {
      // One read, used for both the header figure and the funding check. This
      // was two identical eth_getBalance calls back to back on every poll.
      let bb: bigint | null = null;
      try { bb = await pub.getBalance({ address: guestAddress }); setBal(bb); } catch {}
      try {
        if (bb === null) throw new Error('balance unavailable');
        // FUNDING INVARIANT, and web/api/topup.js has to move with this file.
        // Measured on testnet at a 100 gwei base fee, and Monad charges
        // gas_limit rather than gas_used: openJob alone costs 0.03 MON, and a
        // first order that also deposits costs about 0.06. So every trigger
        // here must sit ABOVE the cost of one full order, or a guest holding
        // more than the threshold and less than an order is stuck forever with
        // no way to move their own balance. It must also sit BELOW
        // TOPUP_RECIPIENT_MAX (0.5), or the app asks for a top-up the faucet
        // always refuses and loops. 0.1 satisfies both with a 5x margin, and a
        // single 0.25 grant always clears it.
        // Burner only. With the guest's own wallet connected, the house has
        // no business pushing MON at an address it does not control: the
        // faucet exists to make the burner demo openable, not to subsidise
        // arbitrary wallets, and an automatic grant to a connected address is
        // also the thing that makes every usage figure house-to-house flow.
        // The manual button stays available in both modes.
        if (wallet.mode === 'burner' && bb < TOPUP_TRIGGER && !sessionStorage.getItem('dn_topped')) {
          // Flag set only on success. Set before the await, one 429 from the
          // shared per-IP cooldown permanently disabled the auto-path for the
          // tab, which is the likeliest failure in a demo room behind one NAT.
          try {
            await faucet(guestAddress);
            sessionStorage.setItem('dn_topped', '1');
          } catch (e) { console.error('auto top-up failed', e); }
        }
      } catch {}
      await loadProviders().catch(() => {});
      try {
        // One jobCounter read drives both the stat and the walk below. It was
        // read twice per poll, and the second read could disagree with the
        // first if a job opened between them.
        const n2 = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobCounter' }) as bigint;
        setJobs(n2);
        const rows: any[] = []; let tot = 0n;
        // Bounded: with no open job this used to walk every job back to 1,
        // one sequential RPC call each, on mount and on every settlement.
        const floor = n2 > FEED_WINDOW ? n2 - FEED_WINDOW : 0n;
        // Every job in the window, not just the newest and the first open one.
        // The old loop pushed a row only when `open || id === n2` and then broke
        // at the first open job, so a section headed "live settlements" with a
        // row labelled TOTAL was, in the ordinary case, one job: the newest.
        // Anything already closed and paid - which is to say every settlement
        // that had actually completed - was read from the chain and discarded.
        for (let id = n2; id > floor; id--) {
          try {
            const j = await readJob(ADDR, id);
            const { open, paid, tokens } = j;
            if (paid === 0n && tokens === 0n && !open) continue; // opened and refunded, nothing to show
            tot += paid;
            rows.push({ jobId: id, tokens, amount: paid, open });
          } catch {}
        }
        setFeed(rows);
        setTotal(tot);
        setPulse(x => x + 1);
      } catch {}
    };
    reloadRef.current = () => { clearTimeout(timer); timer = setTimeout(load, 1200); };
    load();
    const startWatch = () => {
      try {
        un = pub.watchContractEvent({
          address: ADDR, abi: ABI, eventName: 'StreamSettled',
          onLogs: () => reloadRef.current(),
          onError: () => setTimeout(startWatch, 5000),
        });
      } catch { setTimeout(startWatch, 5000); }
    };
    startWatch();
    const iv = setInterval(load, 30000);
    return () => { clearTimeout(timer); clearInterval(iv); try { un?.(); } catch {} };
    // Re-runs when the guest connects, disconnects or switches account, or the
    // header would keep showing the previous address's balance and the funding
    // check would keep testing the wrong wallet.
  }, [guestAddress, wallet.mode]);

  // Ask the selected host what it will accept, so the token counter reflects
  // that host's real context window rather than a guess.
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const h = await (await fetch(url + '/health', { headers: TUNNEL_HEADERS, signal: AbortSignal.timeout(6000) })).json();
        if (!dead && h?.promptBudget) setBudgetTokens(Number(h.promptBudget));
        if (!dead) setHostEngine({ engine: h?.engine, model: h?.model });
        if (!dead) setHostPlans(!!h?.plans?.supported);
        if (!dead && h?.provider) setHostProvider(h.provider as `0x${string}`);
        // Plus five seconds for the settle transaction itself to land.
        if (!dead && h?.settleMaxMs) settleGraceRef.current = Number(h.settleMaxMs) + 5000;
      } catch {}
    })();
    return () => { dead = true; };
  }, [url]);

  async function attempt<T>(fn: () => Promise<T>, label: string, tries = 8): Promise<T> {
    let e: any;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (err) {
        e = err;
        setNote(`${label} (${i + 1}/${tries})…`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    throw e;
  }

  // The job this conversation is running on, or null before the first order.
  // Held in a ref rather than state because the order flow reads it inside
  // closures that outlive a render.
  const sessionRef = useRef<{ jobId: bigint; provider: string } | null>(null);

  // Escrow that must remain before a session job is reused. One measured turn
  // on this node bills between 788 and 4,508 tokens, so the floor is set above
  // the largest of those: reusing a job that cannot fund the next answer just
  // moves the failure from openJob to mid-sentence, which is the failure mode
  // the escrow raise exists to remove.
  const SESSION_MIN_REMAINING = parseEther('0.20');

  /// Decide whether an existing job can carry another turn. Every condition is
  /// read from the chain, because the provider, the cloud kitchen and settle()
  /// can all have closed it since the last turn without telling the browser.
  async function reusableJob(
    session: { jobId: bigint; provider: string } | null,
    provider: string,
  ): Promise<bigint | null> {
    if (!session) return null;
    if (session.provider.toLowerCase() !== String(provider).toLowerCase()) return null;
    try {
      const j = await readJob(ADDR, session.jobId);
      if (!isOursAndOpen(j, guestAddress, String(provider))) return null;
      const { escrow, paid } = j;
      if (escrow - paid < SESSION_MIN_REMAINING) return null;
      return session.jobId;
    } catch {
      // A read failure is not evidence the job is usable.
      return null;
    }
  }

  // Any job we opened and did not finish still holds escrow. closeJob returns
  // the unspent remainder to the guest's deposit balance. Without this every
  // failover permanently stranded a job's budget on chain.
  async function releaseJob(jobId: bigint, graceMs = settleGraceRef.current) {
    try {
      // The host settles when the unsettled tokens are worth more than the gas
      // to settle them, with a backstop it publishes as settleMaxMs. Closing
      // from here the instant the stream breaks would trip settle()'s
      // require(j.open) and rob the provider of tokens it already delivered.
      // The old fixed 5s was sized against a 3 second flush interval that no
      // longer exists: with a 60s backstop it could confiscate an entire
      // answer's worth of unsettled work on any failover. Wait out the node's
      // own window, polling so the common case still returns in about a second.
      const deadline = Date.now() + graceMs;
      for (;;) {
        const cur = await readJob(ADDR, jobId);
        if (!cur.open) return;
        if (Date.now() >= deadline) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      const j = await readJob(ADDR, jobId);
      if (!j.open) return;
      const h = await guestWallet.writeContract({ address: ADDR, abi: ABI, functionName: 'closeJob', args: [jobId], gas: 150000n, maxFeePerGas: MAX_FEE });
      await pub.waitForTransactionReceipt({ hash: h });
    } catch (e) {
      console.error('closeJob failed for job', jobId.toString(), e);
    }
  }

  async function rent(resume = false) {
    if (overBudget) { setNote(`prompt is ${promptTokens} tokens, over this host's ${budgetTokens} limit — shorten it`); return; }
    setBusy(true);
    setNote('');
    // The transcript shows the prompt as submitted, so a guest editing the box
    // while an answer streams does not silently rewrite the question it was an
    // answer to. On a resume the original prompt stays; it is the same question.
    if (!resume) { setStream(''); cpRef.current = null; liveRef.current = ''; setCanResume(false); setSentPrompt(prompt); setServedByCloud(false); }
    setThinking(''); setThinkTokens(0);
    const opened: bigint[] = [];
    let finished = false;
    // Set by a {warn} frame, which means the answer completed but the
    // provider's own settlement or closeJob failed. Declared out here because
    // it has to survive the break and drive cleanup below.
    let warned = '';
    try {
      if (!wallet.chainOk) {
        setNote('your wallet is on the wrong network. switch it to Monad testnet and order again.');
        return; // the finally below clears busy and releases anything open
      }
      let b = await pub.getBalance({ address: guestAddress }).catch(() => 0n);
      if (b < TOPUP_TRIGGER) {
        if (wallet.mode === 'injected') {
          // A connected wallet is the guest's own money, so this stops and
          // says so rather than quietly asking the house to fund it. The
          // faucet button in the header is still there if they want to try it.
          setNote(`this wallet holds ${fmt(b)} MON and one order needs about ${formatEther(TOPUP_TRIGGER)}. top it up, or disconnect to use the burner.`);
          return; // the finally below clears busy
        }
        setNote('guest is broke, hitting the faucet…');
        try { await faucet(guestAddress); } catch (e) { console.error('faucet failed', e); }
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 2000));
          b = await pub.getBalance({ address: guestAddress }).catch(() => 0n);
          if (b >= TOPUP_TRIGGER) break;
        }
      }

      // 0.30 MON at RATE_PER_MILLION = 3.353e19 buys about 8,940 billable
      // tokens. Sized from the longest measured job, not from a round number:
      // when a settle exhausts the escrow the CONTRACT closes the job itself
      // (DinnerNode.sol:78), so the guest's answer stops mid-sentence.
      //
      // Raised from 0.10 because the node now bills reasoning tokens, and
      // reasoning is most of what a reasoning model produces. A measured 900
      // word briefing is about 1,200 visible tokens on top of about 3,090
      // reasoning tokens, so it is a 4,290 token job, not a 1,200 token one.
      // The old 0.10 ceiling was 2,980 tokens, which the briefing would have
      // blown through with the answer roughly a third written.
      //
      // The escrow is a ceiling rather than a charge, and it is deposited once:
      // closeJob refunds the unspent remainder to deposits[guest], and the next
      // order tops that back up to budget rather than depositing again. So
      // raising it costs the guest a larger one-time deposit and nothing per
      // order beyond the tokens actually produced.
      // Raised from 0.30 to 1.00 with session jobs. A measured ten turn
      // conversation on this node billed 19,604 tokens; 0.30 MON buys 8,947, so
      // a session at the old ceiling needed two mid-conversation top-ups and
      // every one of them is a moment the answer can stop mid-sentence.
      // 1.00 MON is about 29,800 tokens, which carried the whole measured
      // conversation with room over.
      const budget = parseEther('1.00');
      setNote('opening job…');
      // The staged engrams go in here, not only into applyPendingEngrams below.
      // Storage cannot hold them until openJob has landed, and by then this
      // prompt is already sanitized, hashed and on its way, so the panel's
      // selection has to be applied to the prompt at this point or it never
      // touches the job it was staged for.
      const prepared = await preparePrompt(prompt, sanitization, pendingEngrams);
      setNote(prepared.redactionCount > 0
        ? `privacy: ${prepared.redactionCount} item(s) redacted locally before hashing (pattern matching, best effort, not a guarantee)`
        : 'privacy: no personal data matched by the local patterns (best effort, not a guarantee)');
      await new Promise(r => setTimeout(r, 600));
      const cleanPrompt = prepared.sanitized;
      finalPromptRef.current = cleanPrompt;

      // A fresh random salt per job. The previous construction hashed the
      // prompt with the long-lived Semaphore commitment, which is stable per
      // browser, so identical prompts produced identical tags and short
      // prompts were trivially brute-forceable from the public event.
      // Unlinkability comes from the salt being fresh per job and never
      // leaving this function. Parking it in sessionStorage would only widen
      // the blast radius of any script running on the page.
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const promptTag = keccak256(new TextEncoder().encode(salt + '|' + cleanPrompt));

      // Try the selected host first, then the hosted kitchen. Each attempt
      // gets its own job, and any job that does not finish is closed so its
      // escrow comes back.
      // One target until discovery serves reachable peers. The second entry
      // used to be the hosted kitchen, which answered every failure with a
      // canned passage and a real settlement, so a guest whose node died paid
      // for text no model produced. Failing honestly is better than that.
      // Restoring failover is a matter of putting a peer URL in here, which is
      // what discovery exists to provide.
      const targets = [url];
      let finalJobId: bigint | null = null;

      for (const u of targets) {
        let jobId: bigint | null = null;
        try {
          const health = await attempt(async () => (await fetch(u + '/health', {
            signal: AbortSignal.timeout(9000), headers: TUNNEL_HEADERS,
          })).json(), u === url ? 'warming the tunnel' : 'reaching the hosted kitchen');

          // One job per session rather than one per turn. Reuse is always
          // decided by reading the chain, never by trusting local state: the
          // provider closes a session job when it goes idle, the cloud kitchen
          // closes every job it serves, and settle() closes a job the moment
          // its escrow is exhausted. Any of those can have happened since the
          // last turn, so a job is only reused when the chain says it is open,
          // belongs to this guest and this provider, and still has headroom.
          jobId = await reusableJob(sessionRef.current, health.provider);

          if (jobId === null) {
            const dep = await attempt(() => pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [guestAddress] }) as Promise<bigint>, 'checking your tab');
            if (dep < budget) {
              setNote(`depositing ${formatEther(budget)} MON…`);
              const depHash = await guestWallet.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: budget, gas: 200000n, maxFeePerGas: MAX_FEE });
              await pub.waitForTransactionReceipt({ hash: depHash });
            }

            // The fourth argument is requireCheckpoints, and true is the whole
            // point of v2 from the guest's side: the node cannot be paid for
            // tokens it has not published a keccak checkpoint covering, so the
            // most a failure can cost is one settlement's worth of work rather
            // than the escrow. A chat turn is one growing answer, which is
            // exactly the shape the bound is written for. PlanPanel passes
            // false, because a plan has no single prefix to hash and takes its
            // ceiling from commitPlan instead.
            const h = await guestWallet.writeContract({ address: ADDR, abi: ABI, functionName: 'openJob', args: [health.provider, budget, promptTag, true], gas: 300000n, maxFeePerGas: MAX_FEE });
            const rc = await pub.waitForTransactionReceipt({ hash: h });
            const [log] = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' });
            jobId = log.args.jobId as bigint;
            sessionRef.current = { jobId, provider: String(health.provider) };
          } else {
            setNote(`continuing job#${jobId} — this session's escrow is still open`);
          }
          const jid = jobId; // stable binding: the closures below outlive the narrowing
          opened.push(jid);
          await onJobOpen(jid.toString());
          // Only now does a job binding exist, so this is the first moment the
          // staged template or custom engram can legally be stored. A failure
          // here must not abort the order: the engram is optional and the
          // escrow is already committed on chain.
          await applyPendingEngrams(pendingEngrams).catch(e => console.error('engram apply failed', e));

          const cp = cpRef.current;
          setNote(u === url
            ? `job#${jobId} open — prompt committed (${promptTag.slice(0, 10)}…) — streaming from ${health.model}…`
            : `host dropped${cp ? ` after ${cp.n} tokens` : ''} — continuing on the hosted kitchen…`);

          // Show the committed prefix and nothing after it. Whatever this
          // provider sends either continues that prefix or replaces it, so
          // anything the previous provider streamed past the last checkpoint
          // must be dropped rather than concatenated with the new answer.
          setServedByCloud(u !== url || canned);
          const base = cp?.h ? cp.text : '';
          liveRef.current = base;
          setStream(base);
          // Reasoning belongs to the attempt that produced it. A failover to a
          // second provider starts its own.
          setThinking(''); setThinkTokens(0);

          const ac = new AbortController();
          abortRef.current = ac;
          // The host heartbeats ": hb" every second, which keeps the socket
          // open forever if the engine wedges after headers are sent. Without
          // a watchdog the reader never resolves and busy never clears.
          //
          // Two budgets. The pre-first-byte phase covers the POST and a cold
          // model load, which routinely exceeds twenty seconds on ollama; the
          // old single 20s budget aborted every cold start. Once tokens are
          // flowing, twenty seconds of silence past the 1s heartbeat is a wedge.
          // Measured against TOKENS, not bytes. The heartbeat is a byte, so
          // keying off bytes broke this twice over: the first ": hb" at t=1s
          // flipped `streaming` true and collapsed the cold-start grace to 20s
          // long before any token existed, and the 1s heartbeat then kept
          // refreshing the deadline, which is exactly the wedge this watchdog
          // exists to catch. Time-to-first-token is ~48s for a 27B that has to
          // evict and load, so the cold budget has to clear that with room.
          //
          // The cold budget scales with prompt length, because prompt
          // evaluation dominates it. Measured on the reference laptop: a 17,042
          // token prompt took ~110s before the first token, about 158 tok/s of
          // prompt eval, on top of ~48s if the model has to load. A fixed
          // budget cannot serve both ends of a 30,720 token range: 150s aborts
          // every long prompt, and a constant big enough for the longest one
          // leaves a wedged short job hanging for minutes.
          let lastToken = Date.now();
          let streaming = false;
          let streamErr = '';
          //
          // The 60s floor is not enough on its own. A node serving a model too
          // large for its VRAM runs most layers on the CPU: measured on the
          // reference laptop, a 27B already resident took 84s to the first
          // token on a 14 token prompt, so every job on it was aborted before
          // it produced anything. The host now measures that on startup and
          // publishes it as firstTokenMs, so the budget can come from the node
          // in front of us rather than from an assumption about it. Three times
          // measured, because the measurement was taken on an idle machine and
          // a guest arrives on a busy one. Capped, because a node this slow is
          // one the guest should be leaving, not waiting on for ten minutes.
          const measured = Number(health?.firstTokenMs) || 0;
          const COLD_BUDGET_MS =
            Math.min(300000, Math.max(60000, measured * 3)) + Math.ceil(promptTokens / 150) * 1000;
          const watchdog = setInterval(() => {
            const budget = streaming ? 30000 : COLD_BUDGET_MS;
            if (Date.now() - lastToken > budget) ac.abort();
          }, 2000);

          const res = await attempt(() => fetch(u + '/job', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...TUNNEL_HEADERS },
            signal: ac.signal,
            // The checkpoint travels with the request. Only a checkpoint with
            // a real hash is sendable: the host verifies keccak(text) === h and
            // rejects the request outright on a mismatch.
            body: JSON.stringify({ jobId: jid.toString(), prompt: cleanPrompt, session: true, resume: cp?.h ? { text: cp.text, n: cp.n, h: cp.h } : undefined }),
          }), 'waking the GPU');

          if (!res.ok) { setNote(await res.text()); throw new Error('host refused'); }

          const reader = res.body!.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let gotDone = false;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i: number;
              while ((i = buf.indexOf('\n')) >= 0) {
                const l = buf.slice(0, i); buf = buf.slice(i + 1);
                if (l === 'data: [DONE]') { gotDone = true; continue; }
                if (!l.startsWith('data: ')) continue;
                try {
                  const msg = JSON.parse(l.slice(6));
                  // Only a real token proves the engine is producing, so this
                  // is the one place the watchdog's clock may be reset.
                  if (msg.t) { lastToken = Date.now(); streaming = true; liveRef.current += msg.t; setStream(x => x + msg.t); }
                  // A thinking frame proves the engine is producing just as a
                  // token does, so it refreshes the watchdog. It deliberately
                  // does NOT set `streaming`: that collapses the budget to the
                  // 30s wedge timer, and this node thinks for up to 47s before
                  // the first visible character. Reasoning is displayed, never
                  // appended to liveRef, so it cannot enter a checkpoint or
                  // the visible answer. It is billed by the host, but the
                  // checkpoint chain covers the visible answer only.
                  if (msg.th) { lastToken = Date.now(); setThinking(x => x + msg.th); setThinkTokens(n => n + 1); }
                  // A checkpoint frame is written after the tokens it covers,
                  // so at this instant liveRef holds exactly the prefix that
                  // msg.cp.h hashes. Snapshotting here, rather than tracking
                  // the running text, is what makes the resume payload
                  // verifiable by the next provider.
                  if (msg.cp) cpRef.current = { text: liveRef.current, n: msg.cp.n, h: msg.cp.h };
                  // The node's own count, which is what it settled against.
                  // Frame counting above should already agree; this makes the
                  // displayed number the billed number by construction rather
                  // than by the two staying in step.
                  if (msg.bill && typeof msg.bill.reasoning === 'number') setThinkTokens(msg.bill.reasoning);
                  // The host writes {err} and then STILL writes the final
                  // checkpoint and [DONE]. Treating [DONE] as success here
                  // showed the guest a truncated answer, a success message and
                  // a charge, with no failover and the error overwritten a
                  // moment later. Record it and refuse to call the stream
                  // finished, so the loop moves to the next provider and the
                  // checkpoint continuation resumes the prefix already paid for.
                  if (msg.err) { console.error('provider error frame', u, msg.err); streamErr = String(msg.err); setNote('provider error: ' + msg.err); }
                  // {warn} means the answer arrived but a settlement or
                  // closeJob failed on the provider side. Not an answer
                  // failure, so it must not trigger failover, but it does mean
                  // the job may still be open with escrow in it.
                  if (msg.warn) { console.warn('settlement warning', u, msg.warn); warned = String(msg.warn); }
                } catch {}
              }
            }
            // A producer that ends without a trailing newline would strand
            // the last line, and that line can be [DONE]. Neither producer
            // does this today; the flush costs nothing and removes the class.
            if (buf.trim() === 'data: [DONE]') gotDone = true;
          } finally {
            clearInterval(watchdog);
            abortRef.current = null;
            try { await reader.cancel(); } catch {}
          }
          if (gotDone && !streamErr) { finalJobId = jid; finished = true; break; }
          throw new Error(streamErr ? 'provider errored mid-stream: ' + streamErr : 'stream ended without [DONE]');
        } catch (e) {
          console.error('provider attempt failed', u, e);
          if (jobId !== null) { setNote('releasing escrow from the unfinished job…'); await releaseJob(jobId); }
        }
      }

      if (!finished || finalJobId === null) {
        setCanResume(!!cpRef.current?.n);
        throw new Error('no provider finished the order');
      }

      const job = await readJob(ADDR, finalJobId);
      const cost = job.paid;
      setSessionCost(c => c + cost);
      setNote(warned
        ? 'order delivered, but the provider reported a settlement problem. Releasing any unspent escrow.'
        : 'order up, see the check →');
      setCanResume(false);
      // Read the finished answer from the ref rather than from a setState
      // updater. The updater ran twice under StrictMode and prepended the
      // entry each time, and it stored the raw pre-sanitization prompt, which
      // put exactly the text the redaction pipeline exists to remove into
      // localStorage permanently.
      const entry: Session = {
        ts: Date.now(), prompt: finalPromptRef.current, answer: liveRef.current,
        jobId: finalJobId.toString(), cost: cost.toString(),
      };
      if (cost > 0n && sessionRef.current) setRatedProvider(sessionRef.current.provider as `0x${string}`);
      const next = [entry, ...loadSessions()].slice(0, 20);
      try { localStorage.setItem('dn_sessions', JSON.stringify(next)); } catch {}
      setSessions(next);
      reloadRef.current();
    } catch (e: any) {
      console.error('rent failed', e);
      setNote(e?.message === 'no provider finished the order'
        ? 'no provider finished the order — escrow released. tap resume to continue from the last checkpoint.'
        : 'the kitchen is still warming up — give it a couple seconds and tap place order again.');
    } finally {
      // Belt and braces: close anything still open, including on a thrown
      // programmer error, so escrow is never left stranded.
      //
      // The last opened job is skipped on success. Under session jobs that is
      // deliberate rather than incidental: the provider leaves it open for the
      // next turn, and closes it itself once the session goes idle. A {warn}
      // frame is the provider telling us that its own settle or closeJob
      // failed, so in that case the escrow is still sitting there and we are
      // the only party left who can release it. Skipping it on a warn was
      // exactly backwards.
      const providerClosedIt = finished && !warned;
      for (const id of opened) if (!providerClosedIt || id !== opened[opened.length - 1]) await releaseJob(id);
      onJobClose();
      setBusy(false);
    }
  }

  function download(a: { name: string; body: string }) {
    const blob = new Blob([a.body], { type: 'text/plain' });
    const href = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = href; el.download = a.name; el.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  return (
    <div className="wrap">
      <header>
        <h1>DinnerNode<span className="dot" key={pulse} /></h1>
        <p className="tag">idle compute, settling every second</p>
        <span className="addr">
          contract <a href={`${EXPLORER}/address/${ADDR}`} target="_blank" rel="noreferrer">{short(ADDR)}</a>
          {' '}· {wallet.mode === 'injected' ? wallet.label : 'burner'}{' '}
          <a href={`${EXPLORER}/address/${guestAddress}`} target="_blank" rel="noreferrer">{short(guestAddress)}</a>
          {' '}· {fmt(bal)} MON
          {wallet.mode === 'injected'
            ? <button onClick={() => disconnect()}>disconnect</button>
            : wallet.wallets.length > 1
              // With two extensions installed, connecting to "the wallet"
              // means connecting to whichever one won a race. EIP-6963 is what
              // makes them distinguishable, so having discovered them the page
              // should let the guest say which.
              ? wallet.wallets.map(w => (
                  <button key={w.rdns} disabled={wallet.connecting} onClick={() => void connect(w.rdns)}>
                    connect {w.name}
                  </button>
                ))
              : <button disabled={wallet.connecting} onClick={() => void connect()}>
                  {wallet.connecting ? 'connecting…' : 'connect wallet'}
                </button>}
          <button onClick={async () => { try { await faucet(guestAddress); } catch {} reloadRef.current(); }}>faucet</button>
        </span>
        {wallet.mode === 'injected' && !wallet.chainOk && (
          <span className="addr">
            this wallet is not on Monad testnet, so it cannot open a job.
            <button onClick={() => void switchChain()}>switch network</button>
          </span>
        )}
        {wallet.error && <span className="addr">{wallet.error}</span>}
        {wallet.mode === 'burner' && (
          <span className="addr dim">
            you are spending a burner key this page generated and the house funded.
            connect a wallet to pay the provider with testnet MON of your own.
          </span>
        )}
        <span className="addr">
          <a href="/hosting.html">run a node</a> · <a href="/terms.html">terms</a> · <a href="/acceptable-use.html">acceptable use</a> · testnet only, MON here has no monetary value
        </span>
      </header>

      <div className="stats">
        jobs {jobs.toString()} · providers {providers.length} · settled in the last {feed.length} jobs <b>{fmt(total)} MON</b>
        {discoveryUp === false && <span className="dim"> · discovery offline, using known list</span>}
      </div>

      <main>
        <section>
          <h2>on the clock</h2>
          {providers.length === 0 && <div className="card dim">nobody's cooking yet — run `npm run host`</div>}
          {providers.map(p => (
            <div className="card" key={p.p}>
              <div className="model">
                {p.model}{p.active ? <span className="dot small" /> : null}
                {p.url && p.url !== url && <button onClick={() => setUrl(p.url)}>use</button>}
              </div>
              <div className="dim">{p.hw}</div>
              <div className="dim">earned {fmt(p.earned)} MON · {p.tokensServed.toString()} tok · {p.jobsDone.toString()} jobs</div>
            </div>
          ))}
          {/* Replaced the "your kitchen (sim)" card. It generated rows locally
              and settled nothing, so the one thing on the page inviting someone
              to become a provider was the one thing that was not real. */}
          <div className="card">
            <div className="model">your kitchen</div>
            <div className="dim">Turn an idle GPU into a node. One command, and it serves real jobs
              for real settlements.</div>
            <a className="cta" href="/hosting.html">run a node →</a>
          </div>
        </section>

        <section>
          <h2>rent compute</h2>
          <div className="note">You are interacting with an AI system. Responses are machine generated and may be inaccurate.</div>
          <div className="rowline">
            <input value={url} onChange={e => setUrl(e.target.value)} />

          </div>
          {canned && <div className="note">Note: the hosted kitchen returns a fixed demo passage, not model inference. Its on-chain settlements are real.</div>}
          {hostEngine?.engine === 'mock' && (
            <div className="note">
              Note: this host reports engine "mock". It returns canned text rather than model
              output, and its settlements are still real MON. Pick another host.
            </div>
          )}
          {hostPlans && (
            <div className="rowline">
              <button className={mode === 'answer' ? 'order' : ''} onClick={() => setMode('answer')}>one answer</button>
              <button className={mode === 'plan' ? 'order' : ''} onClick={() => setMode('plan')}>plan a job</button>
              <span className="dim">this host executes plans</span>
            </div>
          )}
          {hostEngine?.engine && hostEngine.engine !== 'mock' && (
            <div className="dim">host runs {hostEngine.model} via {hostEngine.engine}</div>
          )}
          {/* The selector used to sit inside the .rowline flex row alongside the
              textarea. It is a full panel, so it took the row's width and the
              textarea's flex:1 collapsed it to a few pixels. It is its own block
              now and the row holds only the prompt and its controls. */}
          {mode === 'plan' && hostPlans && hostProvider && (
            <Suspense fallback={<div className="dim">loading the plan panel…</div>}>
              <PlanPanel
                pub={pub}
                wallet={guestWallet}
                guestAddress={guestAddress}
                nodeAddress={ADDR}
                nodeAbi={ABI}
                host={url}
                provider={hostProvider}
                maxFee={MAX_FEE}
                explorer={EXPLORER}
              />
            </Suspense>
          )}

          <EngramSelector onSanitizationChange={setSanitization} onPendingChange={setPendingEngrams} />

          {/* Transcript above, composer below, which is the shape every reader
              already knows from a chat client. The answer used to sit in a
              180px box under the controls, so the most valuable thing on the
              page was also the smallest. */}
          <div className="chat" style={{ display: mode === 'plan' ? 'none' : undefined }}>
            <div className="transcript" ref={streamRef}>
              {!sentPrompt && !stream && (
                <div className="empty">
                  <p>Ask for something.</p>
                  <p className="dim">It is served by the node selected above, and settles on chain
                    token by token as it streams. Long jobs are the interesting case: the answer
                    survives its provider going away.</p>
                </div>
              )}
              {sentPrompt && <div className="msg user">{sentPrompt}</div>}
              {(stream || busy) && (
                <div className="msg assistant">
                  {/* The answer is attacker-controlled: a hostile provider can
                      stream markup, and the guest key sits in localStorage
                      under dn_pk. marked does not sanitize, so the output is
                      scrubbed before it is set. */}
                  {servedByCloud && (
                    <div className="note">Served by the hosted kitchen: this text is a fixed demo passage, not model inference. Its on-chain settlements are real.</div>
                  )}
                  {/* Collapsed by default, and open on its own while nothing
                      visible has arrived yet. Before this existed the guest saw
                      an empty box for the whole reasoning phase, which reads as
                      a broken node rather than as a working one. Reasoning is
                      plain text, not markdown: it is untrusted provider output
                      and there is no reason to give it a renderer. */}
                  {thinking && (
                    <div className={'thinking' + (thinkOpen || !stream ? ' open' : '')}>
                      <button className="thinking-head" onClick={() => setThinkOpen(o => !o)}>
                        {stream ? '▸ thought before answering' : '◌ thinking…'}
                        <span className="dim"> ({thinkTokens} tok, billed as output)</span>
                      </button>
                      {(thinkOpen || !stream) && <div className="thinking-body">{thinking}</div>}
                    </div>
                  )}
                  <div className="md" dangerouslySetInnerHTML={{ __html: renderedStream }} />
                  {busy && !stream && !thinking && <span className="caret">▍</span>}
                  {artifacts.length > 0 && (
                    <div className="artifacts">
                      {artifacts.map(a => <button key={a.name} onClick={() => download(a)}>⭳ {a.name}</button>)}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="composer">
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                rows={3}
                placeholder="Ask for something…"
                onKeyDown={e => {
                  // Enter sends, shift-enter breaks the line. Guard on busy and
                  // overBudget too, or the keyboard bypasses the button's own
                  // disabled state and opens a job the guest cannot afford.
                  if (e.key === 'Enter' && !e.shiftKey && !busy && !overBudget) {
                    e.preventDefault();
                    rent(false);
                  }
                }}
              />
              <div className="composer-row">
                <span className="dim" style={{ color: overBudget ? '#ff6b6b' : undefined }}>
                  {promptTokens} / {budgetTokens} tokens
                </span>
                <span className="note">{note}</span>
                {canResume && !busy && <button onClick={() => rent(true)}>resume from checkpoint</button>}
                <button className="order" disabled={busy || overBudget} onClick={() => rent(false)}>
                  {busy ? 'streaming…' : 'place order'}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section>
          <h2>the check — last {FEED_WINDOW.toString()} jobs</h2>
          <div className="receipt">
            {feed.map((l, i) => (
              <div className="rrow" key={String(l.jobId) + ':' + i}>
                <span>job#{l.jobId.toString()}{l.open ? ' ●' : ''}</span>
                <span>{l.tokens.toString()} tok</span>
                <span>{fmt(l.amount)} MON</span>
              </div>
            ))}
            {feed.length === 0 && <div className="rrow dim"><span>no jobs yet</span></div>}
            {/* Not an all-time total and it must not be labelled as one. It is
                the sum of the window walked above. */}
            <div className="rtotal"><span>WINDOW TOTAL</span><b>{fmt(total)} MON</b></div>
            {sessionCost > 0n && <div className="rcost">guest cost −{fmt(sessionCost)} MON</div>}
          </div>
          {RATINGS_ON && ratedProvider && sessions.length > 0 && (
            <Suspense fallback={<div className="dim">loading the proving stack…</div>}>
            <ProviderRating
              pub={pub}
              wallet={guestWallet}
              provider={ratedProvider}
              nodeAddress={ADDR}
              guestAddress={guestAddress}
              jobIds={sessions.map(x => BigInt(x.jobId))}
            />
            </Suspense>
          )}
          {sessions.length > 0 && (
            <>
              <h2>earlier orders</h2>
              <div className="receipt">
                {sessions.slice(0, 6).map(s => (
                  <div className="rrow" key={s.ts} onClick={() => { setPrompt(s.prompt); setStream(s.answer); }} style={{ cursor: 'pointer' }}>
                    <span>{s.prompt.slice(0, 28)}{s.prompt.length > 28 ? '…' : ''}</span>
                    <span>job#{s.jobId}</span>
                    <span>{fmt(BigInt(s.cost))} MON</span>
                  </div>
                ))}
                <div className="rcost" onClick={() => { localStorage.removeItem('dn_sessions'); setSessions([]); }} style={{ cursor: 'pointer' }}>clear history</div>
              </div>
            </>
          )}
        </section>
      </main>
      <footer>
        every token is a tip. · prompts are committed on-chain as salted hashes, never as text. the guest wallet address is public on chain and is not anonymised: there is no ZK identity layer in this build.
      </footer>
    </div>
  );
}
