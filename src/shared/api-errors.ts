/**
 * 把原始的 OpenAI 兼容 API 失败转换成用户能据此行动的消息。
 *
 * 刻意做到无 Electron 依赖：`src/main/translate.ts` 过去把它们与 `fetch`/logger
 * 的导入一起内联定义，导致无法做单元测试。任何翻译后端（在线、离线、将来的服务商）
 * 都可以从这里复用它们。
 *
 * 文案取自 `shared/i18n`，`locale` 缺省为中文，便于纯函数单测保持稳定。
 */
import { translate, type Locale } from './i18n';

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
export function friendlyApiError(status: number, body: string, locale: Locale = 'zh'): string {
  const serverMsg = extractServerMessage(body);
  if (status === 401 || status === 403) {
    return translate(locale, 'errors.api.invalidKey');
  }
  if (status === 429) {
    return serverMsg || translate(locale, 'errors.api.quota');
  }
  if (status >= 500) {
    return serverMsg || translate(locale, 'errors.api.server');
  }
  if (serverMsg) return translate(locale, 'errors.api.requestFailed', { status, msg: serverMsg });
  // 解析失败或未知错误：给出通用提示，避免暴露晦涩的原始报文。
  return translate(locale, 'errors.api.generic');
}

/**
 * 把抛出的 `fetch`/中止错误映射为友好消息。网络层故障（DNS、拒绝、超时、中止）
 * 给一条通用提示；其它错误保留原始消息，使真正的 bug 仍可诊断。
 */
export function friendlyNetworkError(message: string, locale: Locale = 'zh'): string {
  return /network|fetch failed|abort|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)
    ? translate(locale, 'errors.network')
    : translate(locale, 'errors.request', { msg: message });
}