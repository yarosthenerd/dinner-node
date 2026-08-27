// The hosting calculator, rendered.
//
// The arithmetic is proven against src/earnings.ts in the node suite. What
// that cannot catch is the half that only exists in the browser: an element id
// that does not match the markup, a template that throws, a control nobody
// wired up. This mounts the real hosting.html body and drives the real script.
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// jsdom rewrites import.meta.url to an http URL, so the path is resolved from
// the vitest root instead.
const html = readFileSync(resolve(__dirname, '../../../public/hosting.html'), 'utf8');

const set = (id: string, value: string) => {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const out = () => document.getElementById('result')!.textContent!;

beforeAll(async () => {
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  // Imported after the markup exists, because the module wires itself up on
  // load and renders once. That order is the contract the <script type=module>
  // tag at the end of the page relies on.
  // @ts-expect-error -- plain JS with no types, deliberately: it ships as-is
  // to a static page and must stay loadable by a browser with no build step.
  await import('../../../public/hosting-calc.js');
});

describe('the calculator on the page', () => {
  it('renders something on load without being touched', () => {
    expect(out().length).toBeGreaterThan(100);
    expect(out()).toContain('qwen3:8b'); // the 12 GB default
  });

  it('has every control the script binds to', () => {
    for (const id of ['vram', 'ctx', 'hours', 'util', 'watts', 'kwh', 'tps', 'result', 'utilOut', 'hoursOut']) {
      expect(document.getElementById(id), `#${id} missing from hosting.html`).not.toBeNull();
    }
  });

  it('recomputes when VRAM changes', () => {
    set('vram', '32');
    expect(out()).toContain('qwen3.6:35b-a3b');
    set('vram', '12');
    expect(out()).toContain('qwen3:8b');
  });

  it('echoes the sliders so the number is never a mystery', () => {
    set('util', '37');
    expect(document.getElementById('utilOut')!.textContent).toBe('37%');
    set('hours', '9');
    expect(document.getElementById('hoursOut')!.textContent).toBe('9 h');
    set('util', '5');
    set('hours', '12');
  });

  it('labels a measured throughput differently from an extrapolated one', () => {
    set('vram', '12');
    expect(out()).toContain('measured');
    set('vram', '24');
    expect(out()).toContain('estimated');
  });

  it('refuses to quote income for a model with no market listing', () => {
    set('vram', '8');
    expect(out()).toContain('no market price exists');
    expect(out()).not.toContain('per month');
  });

  it('says plainly when the model will not fit', () => {
    set('vram', '6');
    set('ctx', '32768');
    expect(out()).toMatch(/NO|does not fit|run the rest on your CPU/i);
    set('ctx', '16384');
  });

  it('zero utilisation earns zero, which is the honest default case', () => {
    set('vram', '12');
    set('util', '0');
    expect(out()).toContain('$0.00');
    set('util', '5');
  });

  it('lets an operator override throughput with their own measurement', () => {
    set('vram', '12');
    set('tps', '250');
    expect(out()).toContain('250.0 tok/s');
    set('tps', '0');
    expect(out()).toContain('49.5 tok/s');
  });
});
