import { describe, expect, it } from 'vitest';
import { extractServerMessage, friendlyApiError, friendlyNetworkError } from '../api-errors';

describe('extractServerMessage', () => {
  it('reads error.message from an OpenAI-compatible body', () => {
    expect(extractServerMessage('{"error":{"message":"  Invalid key  "}}')).toBe('Invalid key');
  });

  it('falls back to a top-level message field', () => {
    expect(extractServerMessage('{"message":"over quota"}')).toBe('over quota');
  });

  it('returns an empty string for non-JSON or message-less bodies', () => {
    expect(extractServerMessage('<html>502 Bad Gateway</html>')).toBe('');
    expect(extractServerMessage('{"error":{"code":"x"}}')).toBe('');
  });
});

describe('friendlyApiError', () => {
  it('points at the API key for 401 and 403', () => {
    expect(friendlyApiError(401, '')).toContain('API密钥');
    expect(friendlyApiError(403, '')).toContain('API密钥');
  });

  it('prefers the server message for 429', () => {
    expect(friendlyApiError(429, '{"error":{"message":"rate limited"}}')).toBe('rate limited');
  });

  it('falls back to a quota hint for a bare 429', () => {
    expect(friendlyApiError(429, 'not json')).toContain('额度');
  });

  it('treats 5xx as a transient server fault', () => {
    expect(friendlyApiError(503, '')).toContain('服务端');
  });

  it('surfaces the server message for other 4xx', () => {
    expect(friendlyApiError(400, '{"error":{"message":"bad model"}}')).toBe(
      '请求失败（HTTP 400）：bad model'
    );
  });

  it('never leaks the raw body when no message can be parsed', () => {
    const msg = friendlyApiError(400, '<html>nginx internal error</html>');
    expect(msg).not.toContain('nginx');
    expect(msg).toContain('请求失败');
  });
});

describe('friendlyNetworkError', () => {
  it('maps transport-level failures to one generic hint', () => {
    expect(friendlyNetworkError('fetch failed')).toContain('网络连接失败');
    expect(friendlyNetworkError('getaddrinfo ENOTFOUND api.example.com')).toContain('网络连接失败');
    expect(friendlyNetworkError('The operation was aborted')).toContain('网络连接失败');
  });

  it('keeps unrelated errors diagnosable', () => {
    expect(friendlyNetworkError('Cannot read properties of undefined')).toBe(
      '请求失败：Cannot read properties of undefined'
    );
  });
});