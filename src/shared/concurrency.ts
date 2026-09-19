/**
 * 有界并发的任务运行器。
 *
 * 翻译一个章节意味着许多相互独立的分块请求。一次性全部发出会触发服务商的速率
 * 限制；严格串行执行又浪费时间。此工具保持固定数量的任务在途，且不关心完成顺序——
 * 结果按索引而非到达顺序放置。
 *
 * 无依赖，因此可直接单元测试。
 */

/**
 * 以最多 `limit` 个在途任务，对每个条目运行 `worker`。
 *
 * 第一个 rejection 会中止整轮：剩余工作不再启动，错误向上传播。已在运行任务的
 * 取消由调用方负责（通过共享的 AbortSignal），因为只有调用方知道如何停止它们。
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (!items.length) return;

  // 非正的 limit 会造成死锁；按「一次一个」处理。
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

/** 在 `ms` 后 resolve，或 `signal` 先中止时立即 resolve。 */
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
 * 任意一个输入中止时立即中止的信号。
 *
 * 手动组合而非使用 `AbortSignal.any`，后者需要 Node 20.3+——这样无论确切的运行时
 * 版本如何，行为都保持一致。
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