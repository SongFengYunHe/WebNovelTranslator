/**
 * Core OpenAI-compatible translation logic, shared by the IPC `translate`
 * handler, the global-hotkey path and the offline engine.
 */
import type { TranslateResult } from '../shared/types';
import log from './logger';
import { getSettings, normalizeBaseUrl } from './settings';

export interface ChatApiResponse {
  ok: boolean;
  status: number;
  text: string;
  data: any;
}

/** 在途请求的控制器集合，供退出时统一 abort（零残留退出）。 */
const activeControllers = new Set<AbortController>();

/** 中止所有尚未完成的网络请求（主进程退出清理时调用）。 */
export function abortAllRequests(): void {
  for (const c of activeControllers) c.abort();
  activeControllers.clear();
}

/** Call `<base>/chat/completions` with the current settings. */
export async function callChatApi(body: unknown): Promise<ChatApiResponse> {
  const settings = getSettings();
  const base = normalizeBaseUrl(settings.baseUrl);
  const controller = new AbortController();
  activeControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON body (e.g. proxy error page) - keep raw text for the message.
    }
    return { ok: res.ok, status: res.status, text, data };
  } finally {
    clearTimeout(timer);
    activeControllers.delete(controller);
  }
}

/** 从服务商返回体中提取 error.message（兼容 DeepSeek/Kimi 等 OpenAI 兼容格式）。 */
function extractServerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message ?? parsed?.message ?? '';
    return typeof msg === 'string' ? msg.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Turn a non-OK API response into a friendly, user-facing error message
 * (Part E3). Detects network failures, quota/rate-limit (429) and auth (401).
 * 401/403 会专门提醒用户检查 API 密钥；解析失败时给出通用提示。
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
 * Translate `text` using the currently saved settings. `systemPrompt` is
 * composed by the caller (UI / hotkey / offline all use the same builder).
 */
export async function translateViaApi(
  text: string,
  systemPrompt: string,
  opts: { chapterTitle?: string } = {}
): Promise<TranslateResult> {
  const settings = getSettings();
  if (!settings.apiKey) {
    return { success: false, error: '尚未配置 API 密钥，请在设置中添加。' };
  }
  try {
    const result = await callChatApi({
      model: settings.model,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
    });
    if (!result.ok) {
      return { success: false, error: friendlyApiError(result.status, result.text) };
    }
    const content = result.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      return { success: false, error: '模型返回了空内容，请重试。' };
    }
    return { success: true, text: content };
  } catch (err) {
    const msg = (err as Error).message;
    // AbortSignal.timeout / fetch network failure
    const friendly =
      /network|fetch failed|abort|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(msg)
        ? '网络连接失败，请检查设置或稍后重试。'
        : `请求失败：${msg}`;
    log.error('[translate] request failed:', err);
    return { success: false, error: friendly };
  }
}
