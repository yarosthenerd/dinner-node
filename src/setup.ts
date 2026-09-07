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
import { probeHardware, describeHardware, type Gpu } from './hardware.js';
import { gb, rankInstalled, recommend } from './models.js';
import { hasCommand, repoEnvPath, installHint, immutableHint, ollamaServeHint, detectDistro } from './platform.js';
import { resolveCloudflared, downloadCloudflared, approxMB } from './cloudflared.js';
import { probeOllama, startOllama, installCommand, runInstall, ollamaPackage, gpuVendor, OLLAMA_URL } from './ollama.js';
import { startLmStudio, servable, defaultModel } from './lmstudio.js';
import { discover, describe as describeRuntime, KNOWN, type Found } from './runtimes.js';
import { MARKET_ID } from './pricing.js';
import { matchModel } from './model-id.js';

// Overridable so the fresh-operator path (generates a key, writes a new file)
// can be exercised against a throwaway file instead of a real one.
const ENV_PATH = process.env.DINNERNODE_ENV_PATH ?? repoEnvPath(import.meta.url);
const OLLAMA = OLLAMA_URL;
// One answer per run to "what machine is this", read once and passed down.
// Every install route below branches on it, and a probe that can disagree with
// itself between two prompts in the same wizard is worse than no probe.
const DISTRO = detectDistro();
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
// Separate from `failed` on purpose. A LAN-only node is a working node and
// must not stop the launcher, but it earns nothing from the network, and the
// success line has to say which of the two an operator is looking at.
let cannotEarn = false;
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

const has = hasCommand;

/**
 * How to get an engine on THIS machine, in the operator's own words.
 *
 * A thin wrapper so the GPU vendor reaches the immutable branch. That branch
 * prints a container command, and whether the container can see the card is
 * one flag: without it the operator gets an ollama that works, registers,
 * takes jobs and serves them from the CPU without ever saying so.
 */
const ollamaRoute = (gpus: Gpu[]) => DISTRO.immutable
  ? immutableHint(DISTRO, gpuVendor(gpus))
  : installHint('ollama', DISTRO);

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
  // Said out loud because it changes what this wizard offers to run, and an
  // operator who sees the wrong answer here knows why the install command
  // underneath it looks unfamiliar.
  if (DISTRO.pretty || DISTRO.immutable) {
    const flavour = DISTRO.omarchy ? `${DISTRO.pretty}, Omarchy` : (DISTRO.pretty || DISTRO.id);
    const tail = DISTRO.immutable
      // Said here rather than only at the point of failure, because it is the
      // reason the install command further down will not look like the one
      // this operator has seen in every other guide.
      ? `${C.d} (${DISTRO.immutable}: the root filesystem is not installed into)${C.x}`
      : DISTRO.arch ? `${C.d} (pacman routes below)${C.x}` : '';
    ok(`${flavour}${tail}`);
  }

  // ---- engine -----------------------------------------------------------
  // ollama, plus whatever else on this machine already speaks the
  // OpenAI-compatible wire.
  //
  // ollama is the reference: the model sizing in models.ts, the price table in
  // pricing.ts and the warm-up in host.ts are all written against it. But the
  // machines this project wants are Windows and Linux boxes with an idle
  // discrete GPU, and the people who own one and already run a model did not
  // all arrive the same way. Some have LM Studio, some have a KoboldCpp exe in
  // a folder, some compiled llama-server themselves. Telling any of them to
  // install a second runtime and re-download the same weights is the step they
  // stop at, and src/runtimes.ts exists so nobody is asked to.
  //
  // Everything is probed before anything is offered. The wrong question here
  // is "install ollama?" asked of a machine already serving on :5001.
  let engine: 'ollama' | 'runtime' | 'external' = 'ollama';
  let { reachable, models } = await probeOllama(OLLAMA);
  let runtimes = await discover();
  /** The one chosen, when the answer is not ollama. */
  let picked: Found | null = null;

  // An operator who set LLM_BASE_URL themselves has said something this wizard
  // does not argue with, unless it points at something discovery just found,
  // in which case it is this wizard's own earlier answer and is re-checked.
  const configuredBase = (env.get('LLM_BASE_URL') ?? process.env.LLM_BASE_URL ?? '').trim();
  const externalBase = configuredBase && !runtimes.some(r => r.base === configuredBase) ? configuredBase : '';

  if (process.env.ENGINE === 'mock') {
    // Not a state to fix. It is a state to name, because a node serving canned
    // text is not a node earning, and the operator should see it said out loud
    // rather than discover it in a guest's transcript.
    engine = 'external';
    warn('ENGINE=mock: this node will serve the canned demo passage, not a model');
  } else if (externalBase) {
    engine = 'external';
    ok(`engine ${externalBase} ${C.d}(LLM_BASE_URL, set by hand)${C.x}`);
    if (!(env.get('LLM_MODEL') ?? process.env.LLM_MODEL)) {
      warn('LLM_MODEL is unset, so the node will ask that server which model it holds');
    }
  } else {
    if (!reachable && !runtimes.length && !CHECK_ONLY) {
      // Nothing is answering. Start what is installed before offering to
      // install anything: an operator with LM Studio on the machine but closed
      // does not need a second runtime, they need their own one running.
      //
      // Only LM Studio can be started this way, and the table says so rather
      // than this code assuming it. Starting llama-server or vLLM needs a
      // model path this wizard does not have and must not guess at, and
      // KoboldCpp is a file someone double-clicks with no PATH entry to find.
      for (const spec of KNOWN) {
        if (!spec.startable || !spec.cli || !has(spec.cli)) continue;
        if (spec.id === 'lmstudio') await startLmStudio({ log: l => console.log(`    ${C.d}${l}${C.x}`) });
      }
      runtimes = await discover();
      if (!runtimes.length && has('ollama')) {
        ({ reachable, models } = await startOllama({ log: l => console.log(`    ${C.d}${l}${C.x}`) }));
      }
    }

    const installedButClosed = KNOWN.filter(s => s.cli && has(s.cli) && !runtimes.some(r => r.spec.id === s.id));

    if (!reachable && !runtimes.length && !CHECK_ONLY && !has('ollama') && !installedButClosed.length && INTERACTIVE) {
      const inst = installCommand(process.platform, has, DISTRO, hw.gpus);
      console.log(`  ${C.b}?${C.x} no inference engine on this machine, and there is nothing for this node to serve without one.`);
      if (inst) {
        // Shown in full first. On Arch this is a package install that asks for
        // root, and everywhere else on Linux it is a vendor script piped into
        // a shell that escalates to root. Neither is something to start on an
        // operator's behalf from a default.
        console.log(`    ${C.d}${inst.shown}${C.x}`);
        if (DISTRO.arch && !DISTRO.immutable) {
          console.log(`    ${C.d}${ollamaPackage(hw.gpus)} is the package for the card found above${C.x}`);
        }
        if (DISTRO.immutable) {
          console.log(`    ${C.d}a container, because ${DISTRO.immutable} keeps /usr read only${C.x}`);
          if (gpuVendor(hw.gpus) === 'nvidia') {
            console.log(`    ${C.d}--nvidia shares the host driver, without which it would serve from the CPU${C.x}`);
          }
        }
        if (await confirm('run that now?')) {
          console.log();
          const okRun = runInstall(inst);
          console.log();
          if (!okRun) warn('the installer did not finish cleanly');
          ({ reachable, models } = await probeOllama(OLLAMA));
          // The Arch package installs a stopped service, and the vendor script
          // starts one itself. Only the first case needs a nudge.
          if (!reachable && !DISTRO.immutable) {
            ({ reachable, models } = await startOllama({ log: l => console.log(`    ${C.d}${l}${C.x}`) }));
          }
          if (!reachable && DISTRO.immutable) {
            // The install can succeed and still leave nothing this node can
            // talk to. distrobox shares the host network by default, which is
            // what puts the container's :11434 where the probe above looks;
            // a container made with --unshare-netns does not, and the failure
            // is silent from in here. Verified rather than assumed, and the
            // likely cause named, because "installed" and "reachable" are two
            // different facts and only the second one earns anything.
            warn('installed, but nothing is answering on :11434 from here');
            console.log(`    ${C.d}start it: distrobox enter dinnernode -- ollama serve${C.x}`);
            console.log(`    ${C.d}if it is running in there and still not visible, the container does not${C.x}`);
            console.log(`    ${C.d}share the host network: recreate it without --unshare-netns${C.x}`);
          }
        }
      } else {
        for (const l of ollamaRoute(hw.gpus)) console.log(`    ${C.d}${l}${C.x}`);
        console.log(`    ${C.d}or LM Studio, if you would rather manage models in a GUI:${C.x}`);
        for (const l of installHint('lmstudio', DISTRO)) console.log(`    ${C.d}  ${l}${C.x}`);
      }
    }

    // A runtime holding nothing this node can serve a chat from is not a
    // choice. Nor is a KoboldCpp that wants a password we do not have: it
    // would refuse every request, and finding that out here is far cheaper
    // than finding it out after a guest has paid.
    const usable = runtimes.filter(r => servable(r.models).length && !r.needsPassword);
    for (const r of runtimes) {
      if (r.needsPassword) warn(`${describeRuntime(r)} is password protected, so this node cannot use it`);
      else if (!servable(r.models).length) warn(`${describeRuntime(r)} holds no chat model`);
    }

    const ollamaUsable = reachable && models.length > 0;
    if (ollamaUsable && usable.length) {
      console.log(`  ${C.d}${usable.length + 1} engines are running here${C.x}`);
      console.log(`    ${C.d}[1] ollama${' '.repeat(9)}${models.length} model${models.length > 1 ? 's' : ''}, sized against your GPU below${C.x}`);
      usable.forEach((r, i) => {
        const n = servable(r.models).length;
        console.log(`    ${C.d}[${i + 2}] ${describeRuntime(r)}, ${n} model${n > 1 ? 's' : ''}${C.x}`);
      });
      // ollama is the default because everything downstream is measured
      // against it: the fit check knows its KV geometry and the price table is
      // keyed by its tags. Neither is a reason to refuse the others, and both
      // are reasons not to pick one silently.
      const answer = Number((await ask(`serve through which? (1 to ${usable.length + 1})`, '1')).trim());
      if (answer >= 2 && answer <= usable.length + 1) { engine = 'runtime'; picked = usable[answer - 2]; }
      else engine = 'ollama';
    } else if (usable.length === 1) {
      engine = 'runtime';
      picked = usable[0];
    } else if (usable.length > 1) {
      usable.forEach((r, i) => {
        const n = servable(r.models).length;
        console.log(`    ${C.d}[${i + 1}] ${describeRuntime(r)}, ${n} model${n > 1 ? 's' : ''}${C.x}`);
      });
      const answer = Number((await ask(`serve through which? (1 to ${usable.length})`, '1')));
      engine = 'runtime';
      picked = usable[answer - 1] ?? usable[0];
    } else if (reachable) {
      engine = 'ollama';
    } else {
      const closed = installedButClosed[0];
      bad('no inference engine is reachable',
        has('ollama') ? ollamaServeHint()
          : closed?.id === 'lmstudio' ? 'LM Studio is installed but not serving: lms server start'
          : closed ? `${closed.name} is installed but not serving: start it on :${closed.port}`
          : undefined);
      if (!has('ollama') && !closed) {
        for (const l of ollamaRoute(hw.gpus)) console.log(`    ${C.d}${l}${C.x}`);
      }
    }
  }

  // ---- the chosen runtime: model, context, price ------------------------
  if (engine === 'runtime' && picked) {
    const r = picked;
    const usable = servable(r.models);
    const current = env.get('LLM_MODEL') ?? process.env.LLM_MODEL;
    const currentUsable = current && usable.some(m => m.id === current);
    let chosen = currentUsable ? current! : (defaultModel(usable) ?? usable[0].id);

    if (!CHECK_ONLY && !currentUsable && usable.length > 1) {
      const order = usable.map(m => m.id);
      console.log(order.map((id, i) => {
        const m = usable[i];
        const tail = !m.maxCtx && !m.loadedCtx ? `${C.d}context not reported${C.x}`
          : m.loaded ? `${C.g}loaded${C.x} ${C.d}serving ${m.loadedCtx || m.maxCtx} context${C.x}`
          : `${C.d}up to ${m.maxCtx} context${C.x}`;
        return `    [${i + 1}] ${id.padEnd(34)} ${tail}`;
      }).join('\n'));
      const pick = await ask('serve which model? (number or name)', String(order.indexOf(chosen) + 1 || 1));
      chosen = order[Number(pick) - 1] ?? (order.includes(pick) ? pick : chosen);
    }

    const m = usable.find(x => x.id === chosen);
    if (!CHECK_ONLY) {
      setEnv('LLM_BASE_URL', r.base);
      setEnv('LLM_MODEL', chosen);
    }
    ok(`${describeRuntime(r)} ${C.d}serving ${chosen}${C.x}`);
    if (!r.identified) {
      // Said once, plainly. The node will work; what is unverified is only the
      // name printed above it.
      console.log(`    ${C.d}nothing on that port identified itself, so the name above is the port's default${C.x}`);
    }

    // The same defect the missing num_ctx was, in a different runtime. The
    // context a model is loaded with lives in the server, not in the request,
    // and a longer prompt is truncated in silence. A node advertising more
    // than that returns a confident answer to a question the model never fully
    // saw, and gets paid for it. Ollama is the one engine where this is
    // fixable per request; everywhere else the node's own figure has to move.
    const served = (m?.loadedCtx || m?.maxCtx || r.ctx) ?? 0;
    if (!served) {
      warn(`${r.spec.name} did not report a context length, so ${CONTEXT_TOKENS} is unverified`);
      console.log(`    ${C.d}check it in that server; if it is lower, set CONTEXT_TOKENS to match${C.x}`);
    } else if (served < CONTEXT_TOKENS) {
      warn(`${chosen} serves ${served} tokens of context, this node advertises ${CONTEXT_TOKENS}`);
      if (!CHECK_ONLY && await confirm(`advertise ${served} instead, so nothing gets truncated in silence?`)) {
        setEnv('CONTEXT_TOKENS', String(served));
        ok(`context ${served} ${C.d}(written to .env)${C.x}`);
      } else {
        bad('advertising more context than the engine serves',
          `raise the context in ${r.spec.name} for ${chosen}, or set CONTEXT_TOKENS=${served}`);
      }
    } else {
      ok(`context ${CONTEXT_TOKENS} ${C.d}of ${served} the engine serves${C.x}`);
    }

    // Price. The rate table is keyed by ollama tags, and none of these
    // runtimes name a model the way ollama does. `matchModel` reaches the
    // table from any spelling, on equality of a canonical form, and returns
    // nothing rather than a near miss. Both outcomes are shown: a derived
    // match is a claim about money made by parsing a filename, and the
    // operator is the only one who can say it is wrong.
    const priced = matchModel(chosen, Object.keys(MARKET_ID));
    if (priced.tag && priced.how !== 'exact') {
      ok(`priced as ${priced.tag} ${C.d}(matched from the id above; the node prices against that model's market band)${C.x}`);
    } else if (!priced.tag) {
      warn(`no price band for "${chosen}"`);
      console.log(`    ${C.d}it reduces to "${priced.canonical}", which is not a model this node has a market price for${C.x}`);
      console.log(`    ${C.d}so this node will serve at the built-in default rate${C.x}`);
      console.log(`    ${C.d}set RATE_PER_MILLION in .env (wei per million output tokens) to price it yourself${C.x}`);
    }
  }

  // ---- ollama: model choice ---------------------------------------------
  // The one decision an operator cannot make well without help, and the one
  // that decides whether the node is usable. Ollama does not refuse a model
  // that is too large for the GPU: it loads what fits and runs the remaining
  // layers on the CPU, silently. On the reference machine that is a 27B model
  // 56% on CPU, four tokens a second, and 84 seconds to the first token with
  // the model already resident, which is longer than any guest waits.
  //
  // So the wizard sizes rather than lists: weights plus the KV cache at the
  // advertised context, against the memory actually present.
  if (engine === 'ollama') {
    // An LLM_BASE_URL left behind by an earlier run pointing at LM Studio
    // would win in host.ts, which reads it before it looks for ollama. Blanked
    // rather than deleted, so an operator can see the decision in the file.
    if (!CHECK_ONLY && configuredBase && !externalBase) setEnv('LLM_BASE_URL', '');

    if (reachable) {
      if (models.length) ok(`ollama running, ${models.length} model${models.length > 1 ? 's' : ''} installed`);
    }

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
  const tunnelMode = (env.get('TUNNEL') ?? process.env.TUNNEL ?? 'auto').trim().toLowerCase();

  if (publicUrl) {
    ok(`public url ${publicUrl}`);
  } else if (tunnelMode === 'off') {
    // An explicit decision, so it is reported rather than argued with. It is
    // still the state where the node earns nothing.
    warn('TUNNEL=off and no PUBLIC_URL set');
    cannotEarn = true;
  } else {
    let cf = resolveCloudflared();

    // The one dependency between a node that earns and a node that does not,
    // and the only one this wizard can satisfy on its own: a static binary,
    // no Cloudflare account, no token, no DNS. Telling an operator to go and
    // fetch it is how a supply funnel loses people at the last step.
    if (!cf && !CHECK_ONLY && INTERACTIVE) {
      console.log(`  ${C.b}?${C.x} without a tunnel this node serves your LAN only and earns nothing.`);
      if (await confirm(`download cloudflared now? (~${approxMB()} MB, no account needed)`)) {
        const r = await downloadCloudflared({ log: l => console.log(`    ${C.d}${l}${C.x}`) });
        if (r.ok) cf = { path: r.path, source: 'downloaded' };
        else warn(`download failed: ${r.why}`);
      }
    }

    if (cf) {
      ok(`tunnel ready ${C.d}(cloudflared ${cf.source === 'PATH' ? 'on your PATH' : 'in bin/'})${C.x}`);
      console.log(`    ${C.d}the node opens a quick tunnel at boot and gets a new hostname each restart${C.x}`);
      console.log(`    ${C.d}for one that survives a restart, set PUBLIC_URL: ops/cloudflare-migration.md${C.x}`);
    } else {
      warn('no cloudflared, so this node will serve your LAN only');
      cannotEarn = true;
      console.log(`    ${C.d}install it and re-run, no account needed:${C.x}`);
      for (const l of installHint('cloudflared')) console.log(`    ${C.d}  ${l}${C.x}`);
      console.log(`    ${C.d}or set PUBLIC_URL in .env to any tunnel you already run${C.x}`);
    }
  }

  finish();
}

function finish(): never {
  console.log();
  if (failed) {
    console.log(`${C.r}not ready${C.x} — fix the items above and run ${C.b}npm run setup${C.x} again\n`);
    process.exit(1);
  }
  if (cannotEarn) {
    // Exit 0 regardless: LAN-only is a mode an operator may have chosen, and
    // failing here would stop the launcher for someone who wants exactly this.
    // What was wrong before was not the exit code, it was printing "ready"
    // over a node that cannot be reached by a paying guest.
    console.log(`${C.y}ready for your LAN, and it will not earn${C.x} — nothing on the network can reach it.`);
    console.log(`${C.d}serve anyway with ${C.x}${C.b}npm run host${C.x}${C.d}, or fix the reachability item above and re-run.${C.x}\n`);
    process.exit(0);
  }
  console.log(`${C.g}ready${C.x} — start serving with ${C.b}npm run host${C.x}\n`);
  process.exit(0);
}

main().catch(e => { console.error(`\n${C.r}setup failed:${C.x}`, e?.message ?? e, '\n'); process.exit(1); });
