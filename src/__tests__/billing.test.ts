import { describe, expect, it } from 'vitest';
import { bill, flush, hold, newLedger, writeOff } from '../billing';

describe('the ledger', () => {
  it('holds produced tokens away from the settle path', () => {
    const l = newLedger();
    hold(l, 200);
    // The ticker reads delta and nothing else, so 200 tokens of in-flight work
    // are worth zero until something says they were delivered.
    expect(l.delta).toBe(0);
    expect(l.hold).toBe(200);
    expect(flush(l)).toBe(0);
  });

  it('bills held tokens once the work is delivered', () => {
    const l = newLedger();
    hold(l, 120);
    expect(bill(l)).toBe(120);
    expect(l.hold).toBe(0);
    expect(flush(l)).toBe(120);
  });

  it('writes off held tokens when the work fails, and reports the size', () => {
    const l = newLedger();
    hold(l, 3400);
    expect(writeOff(l)).toBe(3400);
    expect(l.hold).toBe(0);
    // The whole point: a failed run settles nothing.
    expect(flush(l)).toBe(0);
  });

  it('never bills more than was actually held', () => {
    // The guard that matters under parallel steps: a step reporting a token
    // count larger than the pool cannot invent billable tokens.
    const l = newLedger();
    hold(l, 50);
    expect(bill(l, 5000)).toBe(50);
    expect(l.delta).toBe(50);
    expect(bill(l, 10)).toBe(0);
    expect(l.delta).toBe(50);
  });

  it('ignores a negative or zero release', () => {
    const l = newLedger();
    hold(l, 40);
    expect(bill(l, -100)).toBe(0);
    expect(l.hold).toBe(40);
    expect(l.delta).toBe(0);
  });

  it('keeps billed tokens billed when later work fails', () => {
    // A three step plan where the first two land and the third dies. The guest
    // pays for two steps, not three, and not zero.
    const l = newLedger();
    hold(l, 100); bill(l, 100);
    hold(l, 150); bill(l, 150);
    hold(l, 900);
    expect(writeOff(l)).toBe(900);
    expect(flush(l)).toBe(250);
  });

  it('settles mid-run without disturbing work still in flight', () => {
    // The ticker fires between steps. It must take the delivered 250 and leave
    // the 900 still being produced alone.
    const l = newLedger();
    hold(l, 250); bill(l, 250);
    hold(l, 900);
    expect(flush(l)).toBe(250);
    expect(l.hold).toBe(900);
    // ...and that in-flight work still fails free.
    expect(writeOff(l)).toBe(900);
    expect(flush(l)).toBe(0);
  });

  it('releases per step regardless of the order steps finish in', () => {
    // A wave of three running concurrently accrues to one pool. Completions
    // arrive out of order; each releases its own count and the failed one's
    // tokens are what is left over.
    const l = newLedger();
    hold(l, 300); hold(l, 500); hold(l, 200); // three steps, 1000 held
    bill(l, 200);  // the third finished first
    bill(l, 300);  // then the first
    expect(l.delta).toBe(500);
    expect(writeOff(l)).toBe(500); // the 500 token step failed
    expect(flush(l)).toBe(500);
  });

  it('resets the flush clock so the age trigger measures the right window', () => {
    const l = newLedger(1000);
    hold(l, 10); bill(l);
    flush(l, 5000);
    expect(l.since).toBe(5000);
    expect(l.delta).toBe(0);
  });
});

// The wiring, not just the arithmetic. These drive the real executePlan and
// account for its events exactly the way the /plan/run handler in host.ts does,
// so a change to either side that breaks the policy fails here rather than on
// a live job.
import { executePlan, type Dispatch, type ExecEvent } from '../executor';
import type { Plan, PlanStep } from '../plan';

const step = (id: string, dependsOn: string[] = [], over: Partial<PlanStep> = {}): PlanStep => ({
  id, title: id, prompt: `do ${id}`, maxTokens: 100, dependsOn, ...over,
});

/** The accounting half of the /plan/run handler, lifted verbatim. */
async function runAndAccount(plan: Plan, d: Dispatch) {
  const l = newLedger();
  const events: ExecEvent[] = [];
  for await (const ev of executePlan(plan, d, { maxParallel: 1 })) {
    events.push(ev);
    if (ev.kind === 'token' || ev.kind === 'thought') hold(l);
    if (ev.kind === 'step_done') bill(l, ev.tokens);
  }
  const dropped = writeOff(l);
  return { billed: flush(l), dropped, events, ledger: l };
}

describe('a plan run, accounted the way host.ts accounts it', () => {
  it('bills every token when every step succeeds', async () => {
    const d: Dispatch = async function* () {
      for (const w of ['one', 'two', 'three']) yield { t: w } as any;
    };
    const r = await runAndAccount(
      { version: 1, goal: 'g', steps: [step('a'), step('b', ['a'])] }, d);
    expect(r.billed).toBe(6); // two steps, three tokens each
    expect(r.dropped).toBe(0);
  });

  it('bills nothing at all when the only step fails', async () => {
    const d: Dispatch = async function* () {
      yield { t: 'partial' } as any;
      throw new Error('engine died');
    };
    const r = await runAndAccount({ version: 1, goal: 'g', steps: [step('a')] }, d);
    // The token was produced and streamed, but the step delivered no usable
    // output, so the guest owes nothing. This is the operator's policy.
    expect(r.billed).toBe(0);
    expect(r.dropped).toBe(1);
  });

  it('bills the steps that landed and writes off the one that did not', async () => {
    const d: Dispatch = async function* (s) {
      if (s.id === 'c') { yield { t: 'x' } as any; throw new Error('engine died'); }
      for (const w of ['one', 'two']) yield { t: w } as any;
    };
    const r = await runAndAccount({
      version: 1, goal: 'g',
      steps: [step('a'), step('b', ['a']), step('c', ['b'])],
    }, d);
    expect(r.billed).toBe(4);  // a and b, two tokens each
    expect(r.dropped).toBe(1); // c's single token
    expect(r.ledger.hold).toBe(0);
  });

  it('writes off a step that spent its whole ceiling on reasoning', async () => {
    // The measured failure this policy was written for: a step burns its
    // ceiling thinking and produces no visible answer. executePlan calls that
    // a failure, so none of it is billed.
    const d: Dispatch = async function* () {
      for (let i = 0; i < 5; i++) yield { th: 'hmm' } as any;
    };
    const r = await runAndAccount(
      { version: 1, goal: 'g', steps: [step('a', [], { maxTokens: 5 })] }, d);
    expect(r.events.some(e => e.kind === 'step_failed')).toBe(true);
    expect(r.billed).toBe(0);
    expect(r.dropped).toBe(5);
  });

  it('bills reasoning on a step that does deliver', async () => {
    // The mirror of the case above: reasoning is billable output when the step
    // it belongs to produces an answer. Dropping it would be the opposite
    // error, and section 3.1 of the terms says both are charged.
    const d: Dispatch = async function* () {
      yield { th: 'thinking' } as any;
      yield { t: 'answer' } as any;
    };
    const r = await runAndAccount({ version: 1, goal: 'g', steps: [step('a')] }, d);
    expect(r.billed).toBe(2);
    expect(r.dropped).toBe(0);
  });
});
