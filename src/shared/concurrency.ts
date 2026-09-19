/**
 * Bounded-concurrency task runner.
 *
 * Translating a chapter means many independent chunk requests. Firing them all
 * at once would trip provider rate limits; running them strictly in series
 * wastes the wall-clock time. This runs a fixed number in flight and keeps the
 * completion order irrelevant — results are placed by index, not by arrival.
 *
 * Dependency-free so it can be unit tested directly.
 */

/**
 * Run `worker` over every item with at most `limit` tasks in flight.
 *
 * The first rejection aborts the run: remaining work is not started, and the
 * error propagates. Cancellation of already-running tasks is the caller's job
 * (via a shared AbortSignal), since only the caller knows how to stop them.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (!items.length) return;

  // A non-positive limit would deadlock; treat it as "one at a time".
  const parallelism = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;

  const runners = Array.from({ length: parallelism }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
}

/** Resolve after `ms`, or immediately if `signal` aborts first. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * A signal that aborts as soon as ANY of the inputs aborts.
 *
 * Composed manually rather than with `AbortSignal.any`, which needs Node 20.3+
 * — this keeps the behaviour identical regardless of the exact runtime.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0];

  const controller = new AbortController();
  const forward = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener('abort', forward, { once: true });
  }
  return controller.signal;
}