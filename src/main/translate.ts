/**
 * Core OpenAI-compatible translation logic, shared by the IPC `translate`
 * handler, the global-hotkey path and the offline engine.
 */
import type { TranslateResult } from '../shared/types';
import { friendlyApiError, friendlyNetworkError } from '../shared/api-errors';
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
    log.error('[translate] request failed:', err);
    // AbortSignal.timeout / fetch network failure
    return { success: false, error: friendlyNetworkError((err as Error).message) };
  }
}
