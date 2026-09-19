/**
 * Retry policy for translation requests.
 *
 * A single long chapter is now many parallel chunk requests, so one transient
 * 429 or dropped connection must not fail the whole chapter. Dependency-free
 * and `random`-injectable so the policy can be unit tested deterministically.
 */

/** Total attempts per chunk, including the first one. */
export const MAX_ATTEMPTS = 3;

const BASE_DELAY_MS = 800;
const MAX_DELAY_MS = 8000;

/**
 * HTTP statuses worth retrying: request timeout, conflict, too-early, rate
 * limiting, and any server-side fault. 4xx client errors (401/403/404/422) are
 * NOT retried — repeating them just wastes quota.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Transport-level failures worth retrying: DNS, refused/reset connections,
 * timeouts and aborts.
 */
export function isRetryableError(message: string): boolean {
  return /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|socket hang up|aborted|timed? ?out/i.test(
    message
  );
}

/**
 * Exponential backoff with jitter.
 *
 * `base * 2^(attempt-1)`, capped, then scaled by a random factor in
 * [0.5, 1]. The jitter matters because chunk requests fail together when a rate
 * limit trips — without it they would all retry at the same instant.
 *
 * @param attempt 1-based attempt number that just failed.
 * @param random  injectable RNG, for tests.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.5 + random() * 0.5;
  return Math.round(exponential * jitter);
}