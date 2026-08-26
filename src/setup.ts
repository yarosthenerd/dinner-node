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
const ASSUME_YES = args.has('--yes') || CHECK_ONLY;

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
  const env = readEnvFile();

  // ---- runtime ----------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`node ${process.versions.node}`);
  else bad(`node ${process.versions.node} is too old`, 'DinnerNode needs node 20 or newer: https://nodejs.org');

  // ---- ollama -----------------------------------------------------------
  let models: string[] = [];
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
    models = ((await r.json() as any).models ?? []).map((m: any) => m.name);
    if (models.length) ok(`ollama running, ${models.length} model${models.length > 1 ? 's' : ''} installed`);
    else bad('ollama is running but has no models', 'ollama pull qwen3:8b');
  } catch {
    bad('ollama is not reachable on :11434',
      has('ollama') ? 'it is installed but not running: ollama serve'
                    : 'install it from https://ollama.com/download, then: ollama pull qwen3:8b');
  }

  // ---- model choice -----------------------------------------------------
  // A model with no num_ctx in its Modelfile is served at ollama's 4096 default
  // regardless of what the architecture supports, so a node advertising a large
  // context would silently truncate. Warn rather than block: the host now sends
  // num_ctx per request, which overrides the Modelfile either way.
  if (models.length) {
    const current = env.get('MODEL') ?? process.env.MODEL;
    let chosen = current && models.includes(current) ? current : models[0];
    if (!CHECK_ONLY && (!current || !models.includes(current))) {
      console.log(`    ${C.d}${models.map((m, i) => `[${i + 1}] ${m}`).join('  ')}${C.x}`);
      const pick = await ask('serve which model? (number or name)', '1');
      const byIndex = models[Number(pick) - 1];
      chosen = byIndex ?? (models.includes(pick) ? pick : models[0]);
      setEnv('MODEL', chosen);
    }
    if (current && !models.includes(current)) warn(`MODEL was ${current}, which is not installed`);
    ok(`model ${chosen}`);
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
    ok('cloudflared installed — a tunnel will start with the node');
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
