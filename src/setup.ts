/**
 * Node operator setup.
 *
 * One command between a cloned repo and a registered, reachable provider. It is
 * a doctor as much as a wizard: every check that can fail at runtime is made
 * here first, where it can be explained, rather than at startup where it used
 * to surface as a stack trace from inside viem.
 *
 * Idempotent by construction. Run it as often as you like; it only writes what
 * is missing and never overwrites a key.
 *
 *   npm run setup            interactive
 *   npm run setup -- --check  report only, change nothing, exit 1 if not ready
 *   npm run setup -- --yes    accept defaults, no prompts (CI or scripted)
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { formatEther } from 'viem';
import { pub, DEFAULT_ADDR } from './chain.js';
import { probeHardware, describeHardware } from './hardware.js';
import { gb, rankInstalled, recommend } from './models.js';

// Overridable so the fresh-operator path (generates a key, writes a new file)
// can be exercised against a throwaway file instead of a real one.
const ENV_PATH = process.env.DINNERNODE_ENV_PATH ?? new URL('../.env', import.meta.url).pathname;
const OLLAMA = 'http://localhost:11434';
const FAUCET = 'https://agents.devnads.com/v1/faucet';
// Enough for registerProvider plus a long tail of settle and closeJob calls.
// Monad charges the gas limit, so a node that registers and then runs dry mid
// job strands a guest's escrow rather than failing cleanly.
const MIN_BALANCE = 10n ** 17n; // 0.1 MON

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
// Without a terminal there is nobody to answer a question. readline resolves
// no promise on a closed stdin, so main() simply stopped mid-run, the event
// loop drained, and node exited 0 having printed neither verdict. ./dinnernode
// read that as success and started serving an unconfigured node.
const INTERACTIVE = Boolean(process.stdin.isTTY);
const ASSUME_YES = args.has('--yes') || CHECK_ONLY || !INTERACTIVE;

// The context a node advertises. Read here rather than in host.ts because the
// number decides which models fit: the KV cache at 32768 tokens is as large as
// the weights of an 8B model.
const CONTEXT_TOKENS = Number(process.env.CONTEXT_TOKENS ?? 32768);

// Nothing below may exit 0 by accident. finish() is the only success path.
process.exitCode = 1;

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

let failed = false;
const ok = (m: string) => console.log(`  ${C.g}✓${C.x} ${m}`);
const warn = (m: string) => console.log(`  ${C.y}!${C.x} ${m}`);
const bad = (m: string, fix?: string) => {
  failed = true;
  console.log(`  ${C.r}✗${C.x} ${m}`);
  if (fix) console.log(`    ${C.d}${fix}${C.x}`);
};

const rl = () => createInterface({ input: process.stdin, output: process.stdout });
async function ask(q: string, dflt: string): Promise<string> {
  if (ASSUME_YES) return dflt;
  const i = rl();
  try { return (await i.question(`  ${C.b}?${C.x} ${q} ${C.d}[${dflt}]${C.x} `)).trim() || dflt; }
  finally { i.close(); }
}
async function confirm(q: string): Promise<boolean> {
  if (ASSUME_YES) return true;
  return /^y/i.test(await ask(`${q} (y/n)`, 'y'));
}

/** Read .env as key/value. Comments and blanks ignored, first "=" splits. */
function readEnvFile(): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(ENV_PATH)) return m;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) m.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  return m;
}

/**
 * Append or replace one key, preserving every other line including comments.
 * A whole-file rewrite would silently drop an operator's own settings.
 */
function setEnv(key: string, value: string): void {
  const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  // Trailing newline is normalised away here and added back once at the end, so
  // repeated appends cannot accumulate blank lines or leave the file without a
  // final newline.
  const lines = raw === '' ? [] : raw.replace(/\n$/, '').split('\n');
  const i = lines.findIndex(l => l.trim().startsWith(key + '='));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, lines.join('\n') + '\n');
  // The file holds a private key. Owner-only, always, including when we created
  // it here rather than the operator.
  try { chmodSync(ENV_PATH, 0o600); } catch { /* best effort on non-POSIX */ }
  process.env[key] = value;
}

const has = (cmd: string) => spawnSync('command', ['-v', cmd], { shell: true, stdio: 'ignore' }).status === 0;

async function main() {
  console.log(`\n${C.b}DinnerNode node setup${C.x}\n`);
  if (!INTERACTIVE && !CHECK_ONLY) {
    console.log(`  ${C.d}no terminal attached: taking defaults, asking nothing, downloading nothing${C.x}`);
  }
  const env = readEnvFile();

  // ---- runtime ----------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`node ${process.versions.node}`);
  else bad(`node ${process.versions.node} is too old`, 'DinnerNode needs node 20 or newer: https://nodejs.org');

  // ---- hardware ---------------------------------------------------------
  // Probed before anything is chosen, because every model decision below is
  // decided by one number: how much memory a model may occupy here.
  const hw = probeHardware();
  ok(`${describeHardware(hw)}`);
  ok(`model budget ${gb(hw.budgetMB)} ${C.d}(${hw.budgetSource})${C.x}`);

  // ---- ollama -----------------------------------------------------------
  let reachable = false;
  let models: string[] = [];
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
    models = ((await r.json() as any).models ?? []).map((m: any) => m.name);
    reachable = true;
    if (models.length) ok(`ollama running, ${models.length} model${models.length > 1 ? 's' : ''} installed`);
  } catch {
    bad('ollama is not reachable on :11434',
      has('ollama') ? 'it is installed but not running: ollama serve'
                    : 'install it from https://ollama.com/download');
  }

  // ---- model choice -----------------------------------------------------
  // The one decision an operator cannot make well without help, and the one
  // that decides whether the node is usable. Ollama does not refuse a model
  // that is too large for the GPU: it loads what fits and runs the remaining
  // layers on the CPU, silently. On the reference machine that is a 27B model
  // 56% on CPU, four tokens a second, and 84 seconds to the first token with
  // the model already resident, which is longer than any guest waits.
  //
  // So the wizard sizes rather than lists: weights plus the KV cache at the
  // advertised context, against the memory actually present.
  if (reachable && !models.length) {
    const { pick, fit: f, fitsWhole } = recommend(hw, CONTEXT_TOKENS);
    bad('ollama has no models installed');
    console.log(`    ${C.d}for ${gb(hw.budgetMB)} the best fit is ${C.x}${C.b}${pick.tag}${C.x}` +
      ` ${C.d}(${pick.note}; needs ${gb(f.needMB)} at ${CONTEXT_TOKENS} context)${C.x}`);
    if (!fitsWhole) console.log(`    ${C.d}nothing in the catalog fits whole here, so this is the smallest one${C.x}`);
    if (!CHECK_ONLY && INTERACTIVE && has('ollama') && await confirm(`pull ${pick.tag} now?`)) {
      console.log();
      // Inherit stdio: the pull is minutes long and its progress bar is the
      // only thing telling the operator the machine has not hung.
      const r = spawnSync('ollama', ['pull', pick.tag], { stdio: 'inherit' });
      console.log();
      if (r.status === 0) { models = [pick.tag]; failed = false; ok(`pulled ${pick.tag}`); }
      else bad(`ollama pull ${pick.tag} failed`, 'pull it yourself and re-run');
    } else if (!CHECK_ONLY) {
      // A multi-gigabyte download is not something to start unattended.
      console.log(`    ${C.d}then: ollama pull ${pick.tag}${C.x}`);
    }
  }

  if (models.length) {
    const ranked = await rankInstalled(hw.budgetMB, CONTEXT_TOKENS, OLLAMA).catch(() => []);
    const byName = new Map(ranked.map(r => [r.name, r]));
    const best = ranked.find(r => r.fit?.fits);
    const current = env.get('MODEL') ?? process.env.MODEL;
    const currentUsable = current && models.includes(current);
    // Default to the largest model that fits whole. models[0] used to win,
    // which on this machine is a 22 GB model against 12 GB of VRAM.
    let chosen = currentUsable ? current : (best?.name ?? ranked[0]?.name ?? models[0]);

    // One line per model, each carrying the number that decides it.
    const line = (name: string, i?: number) => {
      const r = byName.get(name);
      const mark = i === undefined ? '   ' : `[${i + 1}]`;
      if (!r?.fit) return `    ${C.d}${mark} ${name}${C.x}`;
      const tail = r.fit.fits
        ? `${C.g}fits${C.x} ${C.d}${gb(r.fit.needMB)} of ${gb(hw.budgetMB)}${C.x}`
        : `${C.y}spills to CPU${C.x} ${C.d}needs ${gb(r.fit.needMB)}, ` +
          `${r.fit.maxCtx > 0 ? `fits at ${r.fit.maxCtx} context` : 'weights alone do not fit'}${C.x}`;
      return `    ${mark} ${name.padEnd(24)} ${tail}`;
    };

    if (!CHECK_ONLY && !currentUsable && ranked.length) {
      const order = ranked.map(r => r.name);
      console.log(order.map((n, i) => line(n, i)).join('\n'));
      const dflt = String(order.indexOf(chosen) + 1 || 1);
      const pick = await ask('serve which model? (number or name)', dflt);
      const byIndex = order[Number(pick) - 1];
      chosen = byIndex ?? (models.includes(pick) ? pick : chosen);
    }
    if (!CHECK_ONLY && chosen !== current) setEnv('MODEL', chosen);
    if (current && !currentUsable) warn(`MODEL was ${current}, which is not installed`);

    const r = byName.get(chosen);
    if (!r?.fit) {
      ok(`model ${chosen}`);
      warn('could not size this model, serving it unchecked');
    } else if (r.fit.fits) {
      ok(`model ${chosen} ${C.d}fits whole: ${gb(r.fit.needMB)} of ${gb(hw.budgetMB)} at ${CONTEXT_TOKENS} context${C.x}`);
    } else if (r.fit.maxCtx >= 8192) {
      // A smaller context is the cheap fix: the KV cache, not the weights, is
      // what pushed this model over. Below 8192 the node is not much use to a
      // guest, so that is not offered as a fix.
      const ctx = Math.min(r.fit.maxCtx, CONTEXT_TOKENS);
      warn(`${chosen} needs ${gb(r.fit.needMB)} at ${CONTEXT_TOKENS} context, ${gb(hw.budgetMB)} available`);
      if (!CHECK_ONLY && await confirm(`serve it at ${ctx} context instead, so it stays on the GPU?`)) {
        setEnv('CONTEXT_TOKENS', String(ctx));
        ok(`context ${ctx} ${C.d}(written to .env)${C.x}`);
      } else {
        warn('serving with layers on the CPU: expect single-digit tokens per second');
      }
    } else {
      warn(`${chosen} does not fit in ${gb(hw.budgetMB)} at any useful context`);
      // Nothing installed fits, so the fix is a different model rather than a
      // different context. Offer the strongest catalog entry this machine can
      // hold, and switch to it if the operator takes the offer.
      const { pick, fitsWhole } = recommend(hw, CONTEXT_TOKENS);
      let fixed = false;
      if (fitsWhole && !CHECK_ONLY && INTERACTIVE && has('ollama')) {
        console.log(`    ${C.d}${pick.tag} would fit whole and be several times faster${C.x}`);
        if (await confirm(`pull ${pick.tag} and serve that instead?`)) {
          console.log();
          const pull = spawnSync('ollama', ['pull', pick.tag], { stdio: 'inherit' });
          console.log();
          if (pull.status === 0) { setEnv('MODEL', pick.tag); ok(`model ${pick.tag} ${C.d}fits whole${C.x}`); fixed = true; }
          else bad(`ollama pull ${pick.tag} failed`, 'pull it yourself and re-run');
        }
      } else if (fitsWhole) {
        console.log(`    ${C.d}a model that fits would be several times faster: ollama pull ${pick.tag}${C.x}`);
      }
      if (!fixed) {
        warn('serving with layers on the CPU: expect single-digit tokens per second');
        console.log(`    ${C.d}this is the state where a guest's client gives up before the first token${C.x}`);
      }
    }
  }

  // ---- wallet -----------------------------------------------------------
  let pk = env.get('PROVIDER_PK') ?? process.env.PROVIDER_PK ?? '';
  if (pk && !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    bad('PROVIDER_PK in .env is not a valid 32-byte hex key',
      'remove the line and re-run to generate a fresh one');
    pk = '';
  } else if (!pk) {
    if (CHECK_ONLY) {
      bad('no PROVIDER_PK', 'run: npm run setup');
    } else {
      // Never regenerate over an existing key: that would orphan the on-chain
      // reputation and any unwithdrawn earnings tied to the old address.
      pk = generatePrivateKey();
      setEnv('PROVIDER_PK', pk);
      ok(`generated a node wallet, saved to .env ${C.d}(0600)${C.x}`);
    }
  }

  if (!pk) { finish(); return; }
  const me = privateKeyToAccount(pk as `0x${string}`).address;
  ok(`node wallet ${me}`);

  // ---- registry address -------------------------------------------------
  if (!env.get('DINNER_NODE_ADDRESS') && !CHECK_ONLY) setEnv('DINNER_NODE_ADDRESS', DEFAULT_ADDR);
  ok(`registry ${process.env.DINNER_NODE_ADDRESS ?? DEFAULT_ADDR}`);

  // ---- balance ----------------------------------------------------------
  let bal = 0n;
  try {
    bal = await pub.getBalance({ address: me });
  } catch {
    bad('could not reach Monad testnet RPC', 'check your connection and re-run');
  }
  if (bal >= MIN_BALANCE) {
    ok(`balance ${formatEther(bal)} MON`);
  } else if (CHECK_ONLY) {
    bad(`balance ${formatEther(bal)} MON is below ${formatEther(MIN_BALANCE)}`, 'run: npm run faucet');
  } else {
    warn(`balance ${formatEther(bal)} MON — a node needs gas to register and settle`);
    if (await confirm('request testnet MON from the faucet?')) {
      try {
        const r = await fetch(FAUCET, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chainId: 10143, address: me }),
          signal: AbortSignal.timeout(20000),
        });
        const body = (await r.text()).slice(0, 200);
        if (!r.ok) {
          bad(`faucet refused: ${body}`, `fund ${me} yourself, then re-run`);
        } else {
          // The faucet returns before the transfer confirms.
          process.stdout.write(`    ${C.d}waiting for it to land…${C.x}`);
          for (let i = 0; i < 20 && bal < MIN_BALANCE; i++) {
            await new Promise(r => setTimeout(r, 3000));
            bal = await pub.getBalance({ address: me }).catch(() => bal);
          }
          console.log('\r' + ' '.repeat(40) + '\r');
          if (bal >= MIN_BALANCE) ok(`balance ${formatEther(bal)} MON`);
          else bad('faucet accepted but nothing arrived', `fund ${me} yourself, then re-run`);
        }
      } catch (e: any) {
        bad(`faucet unreachable: ${e?.message ?? e}`, `fund ${me} yourself, then re-run`);
      }
    } else {
      bad('node has no gas', `send testnet MON to ${me}, then re-run`);
    }
  }

  // ---- reachability -----------------------------------------------------
  // A node only earns from guests who can reach it. Without a public URL it
  // still serves the LAN page, which is a real mode, not a failure.
  const publicUrl = env.get('PUBLIC_URL') ?? process.env.PUBLIC_URL ?? '';
  if (publicUrl) {
    ok(`public url ${publicUrl}`);
  } else if (has('cloudflared')) {
    // It said "a tunnel will start with the node", and nothing in this
    // codebase has ever started one. A checklist that reports a thing is
    // handled when it is not is worse than one that says nothing.
    warn('cloudflared installed but no PUBLIC_URL set');
    console.log(`    ${C.d}quick tunnel, no account, random hostname each run:${C.x}`);
    console.log(`    ${C.d}  cloudflared tunnel --url http://localhost:4173${C.x}`);
    console.log(`    ${C.d}then put the https URL in .env as PUBLIC_URL=${C.x}`);
    console.log(`    ${C.d}a named tunnel gives a hostname that survives a restart:${C.x}`);
    console.log(`    ${C.d}  ops/cloudflare-migration.md${C.x}`);
  } else if (has('ngrok')) {
    warn('ngrok installed but no PUBLIC_URL set');
    console.log(`    ${C.d}start it yourself: ngrok http 4173${C.x}`);
    console.log(`    ${C.d}then put the https URL in .env as PUBLIC_URL=${C.x}`);
  } else {
    warn('no tunnel tool — your node will serve the LAN only');
    console.log(`    ${C.d}for public jobs install cloudflared (no account needed):${C.x}`);
    console.log(`    ${C.d}  https://developers.cloudflare.com/cloudflare-tunnel/downloads/${C.x}`);
  }

  finish();
}

function finish(): never {
  console.log();
  if (failed) {
    console.log(`${C.r}not ready${C.x} — fix the items above and run ${C.b}npm run setup${C.x} again\n`);
    process.exit(1);
  }
  console.log(`${C.g}ready${C.x} — start serving with ${C.b}npm run host${C.x}\n`);
  process.exit(0);
}

main().catch(e => { console.error(`\n${C.r}setup failed:${C.x}`, e?.message ?? e, '\n'); process.exit(1); });
