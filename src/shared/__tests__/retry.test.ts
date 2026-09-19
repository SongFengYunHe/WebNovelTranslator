import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, backoffDelayMs, isRetryableError, isRetryableStatus } from '../retry';

describe('isRetryableStatus', () => {
  it('retries rate limits, timeouts and server faults', () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status), `status ${status}`).toBe(true);
    }
  });

  it('does not retry client errors that repeating cannot fix', () => {
    // 重试这些只会浪费额度并推迟真正的错误信息。
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(isRetryableStatus(status), `status ${status}`).toBe(false);
    }
  });
});

describe('isRetryableError', () => {
  it('retries transport-level failures', () => {
    for (const message of [
      'fetch failed',
      'getaddrinfo ENOTFOUND api.example.com',
      'connect ECONNREFUSED 127.0.0.1:11434',
      'read ECONNRESET',
      'The operation was aborted',
      'socket hang up',
    ]) {
      expect(isRetryableError(message), message).toBe(true);
    }
  });

  it('does not retry genuine programming errors', () => {
    expect(isRetryableError('Cannot read properties of undefined')).toBe(false);
    expect(isRetryableError('Invalid JSON')).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially', () => {
    const maxJitter = () => 1; // 抖动因子 = 1
    expect(backoffDelayMs(1, maxJitter)).toBe(800);
    expect(backoffDelayMs(2, maxJitter)).toBe(1600);
    expect(backoffDelayMs(3, maxJitter)).toBe(3200);
  });

  it('caps the delay no matter how many attempts fail', () => {
    expect(backoffDelayMs(10, () => 1)).toBe(8000);
  });

  it('applies jitter in the lower half when the RNG returns 0', () => {
    expect(backoffDelayMs(1, () => 0)).toBe(400);
    expect(backoffDelayMs(3, () => 0)).toBe(1600);
  });

  it('always returns a positive integer', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = backoffDelayMs(2, () => r);
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    }
  });

  it('spreads retries of parallel chunks apart', () => {
    // 确定性检查：两次不同的随机数取值绝不能给出相同的延迟。
    expect(backoffDelayMs(3, () => 0)).not.toBe(backoffDelayMs(3, () => 1));
  });

  it('allows at least three attempts before giving up', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
  });
});