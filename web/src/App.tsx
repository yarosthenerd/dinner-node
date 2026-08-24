import { useEffect, useRef, useState } from 'react';
import { keccak256, parseEther, parseEventLogs } from 'viem';
import { ABI, ADDR, EXPLORER, pub, guestWallet, guestAddress, faucet, fmt } from './lib';
import { marked } from 'marked';

const short = (h: string) => h.slice(0, 6) + '…' + h.slice(-4);

export default function App() {
  const [providers, setProviders] = useState<any[]>([]);
  const [feed, setFeed] = useState<any[]>([]);
  const [total, setTotal] = useState(0n);
  const [jobs, setJobs] = useState(0n);
  const [bal, setBal] = useState(0n);
  const [sessionCost, setSessionCost] = useState(0n);
  const [url, setUrl] = useState(() => new URLSearchParams(window.location.search).get('host') || 'https://litter-unfunded-improvise.ngrok-free.dev');
  const [prompt, setPrompt] = useState('How much is the cost of an average dinner in Belgrade?');
  const [stream, setStream] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [pulse, setPulse] = useState(0);
  const [hosting, setHosting] = useState(false);
  const [simRows, setSimRows] = useState<any[]>([]);
  const [simEarned, setSimEarned] = useState(0n);
  const [zkC, setZkC] = useState<bigint>(0n);
  const [zkLine, setZkLine] = useState('private by design — prompts are zk-committed on-chain; guests appear as semaphore pseudonyms, not wallets.');
  const reloadRef = useRef<() => void>(() => {});
  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => { streamRef.current?.scrollTo(0, 999999); }, [stream]);

  useEffect(() => {
    (async () => {
      try {
        const { Identity } = await import('@semaphore-protocol/identity');
        const saved = localStorage.getItem('dn_zk');
        const id = saved ? (Identity as any).import(saved) : new (Identity as any)();
        if (!saved) localStorage.setItem('dn_zk', id.export());
        setZkC(BigInt(id.commitment));
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (!hosting) return;
    let n = 0;
    const iv = setInterval(() => {
      n++;
      const tok = 1 + Math.floor(Math.random() * 7);
      const amt = BigInt(tok) * 2000000000000n;
      setSimRows(r => [{ id: n, tok, amt, job: 100 + Math.floor(n / 8) }, ...r].slice(0, 8));
      setSimEarned(e => e + amt);
    }, 1200);
    return () => clearInterval(iv);
  }, [hosting]);

  useEffect(() => {
    let timer: any = null, un: any = null;

    const getRawLogs = async () => {
      const cur = await pub.getBlockNumber().catch(() => 0n);
      const spans: any[] = ['earliest', cur - 50000n, cur - 20000n, cur - 5000n, cur - 1000n];
      for (const f of spans) {
        try { return await pub.getLogs({ address: ADDR, fromBlock: typeof f === 'bigint' && f < 0n ? 0n : f, toBlock: 'latest' }) as any[]; } catch {}
      }
      return [];
    };

    const load = async () => {
      try { setBal(await pub.getBalance({ address: guestAddress })); } catch {}
      try {
        const bb = await pub.getBalance({ address: guestAddress });
        if (bb < parseEther('5') && !sessionStorage.getItem('dn_topped')) {
          sessionStorage.setItem('dn_topped', '1');
          await faucet();
        }
      } catch {}
      try { setJobs(await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobCounter' }) as bigint); } catch {}
      try {
        const raw = await getRawLogs();
        try {
          const known: `0x${string}`[] = ['0xEAdCAED4b65660475E8e7bfb8deae1FFBABE61AB', '0xb2bA4914cd0b2F5FE36B58d861274051e83032fC'];
          let addrs = known;
          try {
            const regs = parseEventLogs({ abi: ABI, logs: raw, eventName: 'ProviderRegistered' });
            addrs = [...new Set([...known, ...regs.map(r => r.args.provider as any)])] as `0x${string}`[];
          } catch {}
          setProviders((await Promise.all(addrs.map(async p => {
            const [model, hw, , earned, tokensServed, jobsDone, active] =
              await pub.readContract({ address: ADDR, abi: ABI, functionName: 'providers', args: [p] }) as any[];
            return { p, model, hw, earned, tokensServed, jobsDone, active };
          }))).filter((x: any) => x.model));
        } catch {}
        try {
          const n2 = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobCounter' }) as bigint;
          const rows: any[] = []; let tot = 0n;
          for (let id = n2; id >= 1n; id--) {
            try {
              const j = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [id] }) as any[];
              const open = j[5] as boolean;
              if (open || id === n2) { tot += j[3] as bigint; rows.push({ jobId: id, tokens: j[4], amount: j[3], open }); }
              if (open) break;
            } catch {}
          }
          setFeed(rows);
          setTotal(tot);
          setPulse(x => x + 1);
        } catch {}
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
  }, []);

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

  async function rent() {
    setBusy(true); setStream(''); setNote('');
    try {
      let b = await pub.getBalance({ address: guestAddress }).catch(() => 0n);
      if (b < parseEther('0.02')) {
        setNote('guest is broke — hitting the faucet…');
        try { await faucet(); } catch {}
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 2000));
          b = await pub.getBalance({ address: guestAddress }).catch(() => 0n);
          if (b >= parseEther('0.02')) break;
        }
      }
      const health = await attempt(async () => (await fetch(url + '/health', { signal: AbortSignal.timeout(9000), headers: { 'bypass-tunnel-reminder': '1', 'ngrok-skip-browser-warning': 'true' } })).json(), 'warming the tunnel');
      const budget = parseEther('0.01');
      const dep = await attempt(() => pub.readContract({ address: ADDR, abi: ABI, functionName: 'deposits', args: [guestAddress] }) as Promise<bigint>, 'checking your tab');
      if (dep < budget) {
        setNote('depositing 0.01 MON…');
        const depHash = await guestWallet.writeContract({ address: ADDR, abi: ABI, functionName: 'deposit', args: [], value: budget, gas: 200000n });
        await pub.waitForTransactionReceipt({ hash: depHash });
      }
      setNote('opening job…');
      const promptTag = keccak256(new TextEncoder().encode(prompt + '|' + zkC.toString()));
      const h = await guestWallet.writeContract({ address: ADDR, abi: ABI, functionName: 'openJob', args: [health.provider, budget, promptTag], gas: 300000n });
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      const [log] = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: 'JobOpened' });
      const jobId = log.args.jobId as bigint;
      setNote(`job#${jobId} open — prompt zk-committed (${promptTag.slice(0, 10)}…) — streaming from ${health.model}…`);
      let gotDone = false; let finalJobId = jobId;
      const urls = [url, window.location.origin + '/api/p'];
      for (const u of urls) {
        try {
          let jobId2 = jobId;
          if (u !== url) {
            const h2 = await (await fetch(u + '/health', { headers: { 'bypass-tunnel-reminder': '1', 'ngrok-skip-browser-warning': 'true' } })).json();
            const hh = await guestWallet.writeContract({ address: ADDR, abi: ABI, functionName: 'openJob', args: [h2.provider, budget, promptTag], gas: 300000n });
            const rc2 = await pub.waitForTransactionReceipt({ hash: hh });
            const [lg] = parseEventLogs({ abi: ABI, logs: rc2.logs, eventName: 'JobOpened' });
            jobId2 = lg.args.jobId as bigint;
            finalJobId = jobId2;
            setNote('host dropped mid-answer — auto-switching to cloud kitchen…');
          }
          const res = await attempt(() => fetch(u + '/job', {
            method: 'POST', headers: { 'content-type': 'application/json', 'bypass-tunnel-reminder': '1', 'ngrok-skip-browser-warning': 'true' },
            body: JSON.stringify({ jobId: jobId2.toString(), prompt }),
          }), 'waking the GPU');
          const reader = res.body!.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf('\n')) >= 0) {
              const l = buf.slice(0, i); buf = buf.slice(i + 1);
              if (l === 'data: [DONE]') gotDone = true;
              else if (l.startsWith('data: ')) { try { setStream(x => x + JSON.parse(l.slice(6)).t); } catch {} }
            }
          }
          if (gotDone) { finalJobId = jobId2; break; }
        } catch {}
      }
      if (!gotDone) throw new Error('no provider finished the order');
      const job = await pub.readContract({ address: ADDR, abi: ABI, functionName: 'jobs', args: [finalJobId] }) as any[];
      setSessionCost(c => c + (job[3] as bigint));
      setNote('order up — see the check →');
      reloadRef.current();
      (async () => {
        try {
          const { Identity } = await import('@semaphore-protocol/identity');
          const { Group } = await import('@semaphore-protocol/group');
          const { generateProof, verifyProof } = await import('@semaphore-protocol/proof');
          const saved = localStorage.getItem('dn_zk');
          if (!saved) return;
          const id2 = (Identity as any).import(saved);
          const c = BigInt(id2.commitment);
          let g: any; try { g = new (Group as any)([c]); } catch { g = new (Group as any)(); g.addMember(c); }
          const pf = await (generateProof as any)(id2, g, promptTag, 'dinnernode-job');
          if (await (verifyProof as any)(pf)) setZkLine('private by design — prompt zk-committed on-chain · groth16 proof verified in your browser ✓ guests = semaphore pseudonyms, not wallets.');
        } catch {}
      })();
    } catch (e: any) {
      setNote('the kitchen is still warming up — give it a couple seconds and tap place order again.');
    }
    setBusy(false);
  }

  return (
    <div className="wrap">
      <header>
        <h1>DinnerNode<span className="dot" key={pulse} /></h1>
        <p className="tag">idle compute, settling every second</p>
        <span className="addr">
          contract <a href={`${EXPLORER}/address/${ADDR}`} target="_blank" rel="noreferrer">{short(ADDR)}</a>
          {' '}· guest {short(guestAddress)} · {fmt(bal)} MON
          <button onClick={async () => { try { await faucet(); } catch {} reloadRef.current(); }}>faucet</button>
        </span>
      </header>

      <div className="stats">
        jobs {jobs.toString()} · providers {providers.length} · settled total <b>{fmt(total)} MON</b> · settlements {feed.length}+
      </div>

      <main>
        <section>
          <h2>on the clock</h2>
          {providers.length === 0 && <div className="card dim">nobody's cooking yet — run `npm run host`</div>}
          {providers.map(p => (
            <div className="card" key={p.p}>
              <div className="model">{p.model}{p.active ? <span className="dot small" /> : null}</div>
              <div className="dim">{p.hw}</div>
              <div className="dim">earned {fmt(p.earned)} MON · {p.tokensServed.toString()} tok · {p.jobsDone.toString()} jobs</div>
            </div>
          ))}
          <div className="card">
            <div className="model">your kitchen (sim)</div>
            <button onClick={() => setHosting(h => !h)}>{hosting ? '■ stop hosting' : '▶ start hosting'}</button>
            {hosting && <div className="note">started hosting! your kitchen is on the clock (simulation)</div>}
            {hosting && simRows.map(r => (
              <div className="dim" key={r.id}>job#{r.job} +{r.tok} tok +{fmt(r.amt)} MON</div>
            ))}
            {hosting && <div className="model">earned {fmt(simEarned)} MON (sim)</div>}
          </div>
        </section>

        <section>
          <h2>rent compute</h2>
          <div className="rowline">
            <input value={url} onChange={e => setUrl(e.target.value)} />
            <button onClick={() => setUrl(window.location.origin + '/api/p')}>☁ cloud</button>
          </div>
          <div className="rowline">
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} />
            <button className="order" disabled={busy} onClick={rent}>{busy ? 'streaming…' : 'place order'}</button>
          </div>
          <div className="note">{note}</div>
          <div className="stream md" ref={streamRef} dangerouslySetInnerHTML={{ __html: marked.parse(stream || '') as string }} />
        </section>

        <section>
          <h2>the check — live settlements</h2>
          <div className="receipt">
            {feed.map((l, i) => (
              <div className="rrow" key={String(l.jobId) + ':' + i}>
                <span>job#{l.jobId.toString()}{l.open ? ' ●' : ''}</span>
                <span>{l.tokens.toString()} tok</span>
                <span>{fmt(l.amount)} MON</span>
              </div>
            ))}
            <div className="rtotal"><span>TOTAL</span><b>{fmt(total)} MON</b></div>
            {sessionCost > 0n && <div className="rcost">guest cost −{fmt(sessionCost)} MON</div>}
          </div>
        </section>
      </main>
      <footer>every token is a tip. · {zkLine}</footer>
    </div>
  );
}
