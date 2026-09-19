/**
 * 把原始的 OpenAI 兼容 API 失败转换成用户能据此行动的消息。
 *
 * 刻意做到无依赖、无 Electron：`src/main/translate.ts` 过去把它们与 `fetch`/logger
 * 的导入一起内联定义，导致无法做单元测试。任何翻译后端（在线、离线、将来的服务商）
 * 都可以从这里复用它们。
 */

/** 从服务商响应体中取出 `error.message`（DeepSeek/Kimi/OpenAI 的结构）。 */
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
 * 把非 OK 的 HTTP 响应映射为友好的、面向用户的消息。
 *
 * 401/403 → 指向 API 密钥；429 → 额度/速率限制；5xx → 瞬时服务端故障。服务端返回
 * 了可用消息时我们呈现它，否则回落到通用提示，而不是倾倒原始响应体。
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
 * 把抛出的 `fetch`/中止错误映射为友好消息。网络层故障（DNS、拒绝、超时、中止）
 * 给一条通用提示；其它错误保留原始消息，使真正的 bug 仍可诊断。
 */
export function friendlyNetworkError(message: string): string {
  return /network|fetch failed|abort|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)
    ? '网络连接失败，请检查设置或稍后重试。'
    : `请求失败：${message}`;
}