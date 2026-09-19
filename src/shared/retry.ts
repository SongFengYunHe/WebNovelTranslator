/**
 * 翻译请求的重试策略。
 *
 * 一个长章节现在会变成许多并行的分块请求，因此单个瞬时的 429 或断连不该让整章
 * 失败。无依赖且 `random` 可注入，因此该策略可做确定性的单元测试。
 */

/** 每个分块的总尝试次数，含第一次。 */
export const MAX_ATTEMPTS = 3;

const BASE_DELAY_MS = 800;
const MAX_DELAY_MS = 8000;

/**
 * 值得重试的 HTTP 状态码：请求超时、冲突、过早、速率限制，以及任何服务端故障。
 * 4xx 客户端错误（401/403/404/422）「不」重试——重复它们只会浪费额度。
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * 值得重试的传输层故障：DNS、连接被拒绝/重置、超时与中止。
 */
export function isRetryableError(message: string): boolean {
  return /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|socket hang up|aborted|timed? ?out/i.test(
    message
  );
}

/**
 * 带抖动的指数退避。
 *
 * `base * 2^(attempt-1)`，封顶后再乘以 [0.5, 1] 区间的随机因子。抖动之所以重要，
 * 是因为速率限制触发时分块请求会一起失败——没有抖动它们会在同一瞬间全部重试。
 *
 * @param attempt 刚刚失败的、从 1 开始的尝试序号。
 * @param random  可注入的随机数生成器，供测试使用。
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.5 + random() * 0.5;
  return Math.round(exponential * jitter);
}