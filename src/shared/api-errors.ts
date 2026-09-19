/**
 * Turns raw OpenAI-compatible API failures into messages a user can act on.
 *
 * Dependency-free and Electron-free on purpose: `src/main/translate.ts` used to
 * define these inline alongside `fetch`/logger imports, so they could not be
 * unit tested. Any translation backend (online, offline, future providers) can
 * reuse them from here.
 */

/** Pull `error.message` out of a provider body (DeepSeek/Kimi/OpenAI shape). */
export function extractServerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message ?? parsed?.message ?? '';
    return typeof msg === 'string' ? msg.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Map a non-OK HTTP response to a friendly, user-facing message.
 *
 * 401/403 → point at the API key; 429 → quota/rate limit; 5xx → transient
 * server fault. When the server sent a usable message we surface it, otherwise
 * we fall back to a generic hint rather than dumping the raw response body.
 */
export function friendlyApiError(status: number, body: string): string {
  const serverMsg = extractServerMessage(body);
  if (status === 401 || status === 403) {
    return 'API密钥无效或无权访问，请检查设置中的密钥。';
  }
  if (status === 429) {
    return serverMsg || 'API额度不足或请求过于频繁，请更换密钥或稍后重试。';
  }
  if (status >= 500) {
    return serverMsg || '服务端暂时不可用，请稍后重试。';
  }
  if (serverMsg) return `请求失败（HTTP ${status}）：${serverMsg}`;
  // 解析失败或未知错误：给出通用提示，避免暴露晦涩的原始报文。
  return '请求失败，请检查API设置或稍后重试。';
}

/**
 * Map a thrown `fetch`/abort error to a friendly message. Network-layer
 * failures (DNS, refused, timeout, abort) get one generic hint; anything else
 * keeps its original message so genuine bugs stay diagnosable.
 */
export function friendlyNetworkError(message: string): string {
  return /network|fetch failed|abort|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)
    ? '网络连接失败，请检查设置或稍后重试。'
    : `请求失败：${message}`;
}