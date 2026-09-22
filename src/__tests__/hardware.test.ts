import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { describeHardware, probeHardwareReady, type Hardware } from '../hardware';

const base: Hardware = {
  platform: 'linux', arch: 'x64', cores: 24, cpu: 'test cpu',
  ramMB: 31 * 1024, gpus: [], budgetMB: 15 * 1024,
  budgetSource: 'no GPU detected, half of 31744 MiB system RAM', unified: false,
};
const withGpu: Hardware = {
  ...base,
  gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti Laptop GPU', vramMB: 12227, source: 'nvidia-smi' }],
  budgetMB: 11004, budgetSource: 'NVIDIA GeForce RTX 5070 Ti Laptop GPU, 12227 MiB VRAM, 90% usable',
};

/** No real waiting, and a record of how long it was asked to wait. */
const fakeSleep = () => {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => { slept.push(ms); } };
};

describe('describeHardware', () => {
  it('names the GPU, and says CPU-only when there is none', () => {
    expect(describeHardware(withGpu)).toBe(
      `NVIDIA GeForce RTX 5070 Ti Laptop GPU 12GB | 24 cores | 31GB | ${os.hostname()}`);
    expect(describeHardware(base)).toBe(`CPU-only | 24 cores | 31GB | ${os.hostname()}`);
  });
});

describe('waiting for a driver that has not come up', () => {
  it('does not wait at all when the first probe already sees a GPU', async () => {
    const { slept, sleep } = fakeSleep();
    let probes = 0;
    const hw = await probeHardwareReady({
      probe: () => { probes++; return withGpu; },
      pending: () => { throw new Error('should not have been asked'); },
      sleep,
    });
    expect(hw.gpus).toHaveLength(1);
    expect(probes).toBe(1);
    expect(slept).toEqual([]);
  });

  it('does not wait on a machine that genuinely has no NVIDIA GPU', async () => {
    // The case that must stay fast: a CPU-only box, or an AMD one, where
    // nvidia-smi is not installed. Waiting a minute here would delay every
    // such node's registration for nothing.
    const { slept, sleep } = fakeSleep();
    const hw = await probeHardwareReady({ probe: () => base, pending: () => false, sleep });
    expect(hw.gpus).toEqual([]);
    expect(slept).toEqual([]);
  });

  it('re-probes until the driver answers, and returns the GPU', async () => {
    // The defect this exists for: systemd started the node six seconds after
    // boot, nvidia-smi was not answering, and CPU-only went on chain.
    const { slept, sleep } = fakeSleep();
    let probes = 0;
    const lines: string[] = [];
    const hw = await probeHardwareReady({
      probe: () => (++probes < 4 ? base : withGpu),
      pending: () => true,
      sleep, log: l => lines.push(l),
    });
    expect(hw.gpus).toHaveLength(1);
    expect(probes).toBe(4);
    expect(slept).toEqual([2000, 2000, 2000]);
    expect(lines[0]).toMatch(/waiting up to 60s/);
    expect(lines[1]).toMatch(/GPU ready after/);
  });

  it('gives up loudly rather than waiting forever', async () => {
    // A driver that never comes up must not hold the node out of the registry.
    // Real elapsed time here, because the deadline is read from the clock:
    // 30ms of it, so the test is honest about the loop and still instant.
    const lines: string[] = [];
    const hw = await probeHardwareReady({
      timeoutMs: 30, intervalMs: 10,
      probe: () => base, pending: () => true,
      log: l => lines.push(l),
    });
    expect(hw.gpus).toEqual([]);
    expect(lines.at(-1)).toMatch(/giving up on the GPU/);
  });

  it('stops as soon as the machine says it has no GPU after all', async () => {
    // pending() flipping to false means the probe was conclusive: stop.
    const { slept, sleep } = fakeSleep();
    let asked = 0;
    const hw = await probeHardwareReady({
      probe: () => base,
      pending: () => ++asked === 1,
      sleep,
    });
    expect(hw.gpus).toEqual([]);
    expect(slept).toEqual([2000]);
  });
});
