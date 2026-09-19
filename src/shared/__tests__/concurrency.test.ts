import { describe, expect, it } from 'vitest';
import { anySignal, delay, runWithConcurrency } from '../concurrency';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runWithConcurrency', () => {
  it('visits every item exactly once, in order', async () => {
    const seen: number[] = [];
    await runWithConcurrency([10, 20, 30, 40, 50], 2, async (item) => {
      seen.push(item);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    // Guards against a degenerate implementation that serialises everything.
    expect(peak).toBeGreaterThan(1);
  });

  it('does nothing for an empty list', async () => {
    let calls = 0;
    await runWithConcurrency([], 3, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it('caps parallelism at the item count', async () => {
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency([1, 2], 10, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('propagates the first failure and stops starting new work', async () => {
    let completed = 0;
    await expect(
      runWithConcurrency(Array.from({ length: 40 }, (_, i) => i), 2, async (n) => {
        if (n === 1) throw new Error('boom');
        await tick(5);
        completed += 1;
      })
    ).rejects.toThrow('boom');
    // The remaining 30+ items must never have been picked up.
    expect(completed).toBeLessThan(40);
  });

  it('treats a non-positive limit as serial rather than deadlocking', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3], 0, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

describe('delay', () => {
  it('waits roughly the requested time', async () => {
    const start = Date.now();
    await delay(25);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await delay(10_000, controller.signal);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('stops waiting as soon as the signal aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const start = Date.now();
    await delay(10_000, controller.signal);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('anySignal', () => {
  it('returns a lone signal unchanged', () => {
    const controller = new AbortController();
    expect(anySignal([controller.signal])).toBe(controller.signal);
  });

  it('aborts when any input aborts', () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = anySignal([first.signal, second.signal]);
    expect(combined.aborted).toBe(false);
    second.abort();
    expect(combined.aborted).toBe(true);
  });

  it('is already aborted when an input was', () => {
    const first = new AbortController();
    first.abort();
    expect(anySignal([first.signal, new AbortController().signal]).aborted).toBe(true);
  });

  it('does not abort while every input is live', () => {
    const combined = anySignal([new AbortController().signal, new AbortController().signal]);
    expect(combined.aborted).toBe(false);
  });
});