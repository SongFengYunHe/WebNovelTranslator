/**
 * 核心的 OpenAI 兼容翻译逻辑。
 *
 * 一个章节会被切成多个分块（见 `shared/chunking`），以受限并发进行翻译，每个
 * 分块在遇到瞬时故障时独立重试。已完成的分块按内容哈希缓存，因此部分失败后
 * 重试的代价很低：只有真正失败的分块会被重新请求。
 */
import type { TranslateResult } from '../shared/types';
import { friendlyApiError, friendlyNetworkError } from '../shared/api-errors';
import { chunkText } from '../shared/chunking';
import { anySignal, delay, runWithConcurrency } from '../shared/concurrency';
import { MAX_ATTEMPTS, backoffDelayMs, isRetryableError, isRetryableStatus } from '../shared/retry';
import log from './logger';
import { mainLocale, mt } from './i18n';
import { getSettings, normalizeBaseUrl } from './settings';
import { cacheTranslation, getCachedTranslation, translationCacheKey } from './translation-cache';

/** 单次请求超时，独立于任务级的取消信号。 */
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * 并行翻译的分块数。刻意保持较低：服务商的速率限制通常按账号计，且每个分块
 * 遇到 429 时已会自行重试。
 */
const MAX_CONCURRENT_CHUNKS = 3;

export interface ChatApiResponse {
  ok: boolean;
  status: number;
  text: string;
  data: any;
}

export interface TranslateOptions {
  /** 上报分块完成情况，供界面显示进度。 */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 单个分块的翻译结果。`retryable` 仅供内部使用——它永远不会传到渲染进程，
 * 只用于决定重试循环是否继续。
 */
interface ChunkOutcome {
  ok: boolean;
  text: string;
  error?: string;
  retryable: boolean;
}

/** 进行中的任务，便于从界面取消长章节翻译。 */
const activeJobs = new Set<AbortController>();

/**
 * 中止所有进行中的翻译任务。由界面的取消操作与退出流程调用。幂等。
 */
export function cancelActiveJobs(): void {
  for (const job of activeJobs) job.abort();
  activeJobs.clear();
}

/** 使用当前设置调用 `<base>/chat/completions`。 */
export async function callChatApi(body: unknown, signal?: AbortSignal): Promise<ChatApiResponse> {
  const settings = getSettings();
  const base = normalizeBaseUrl(settings.baseUrl);

  // 请求必须在超时或任务取消「任一」情况下停止。
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const combined = signal ? anySignal([signal, timeout.signal]) : timeout.signal;

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combined,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON 响应体（如代理错误页）——保留原始文本用于提示信息。
    }
    return { ok: res.ok, status: res.status, text, data };
  } finally {
    clearTimeout(timer);
  }
}

/** 对单个分块的一次尝试。从不抛异常——失败以结果对象返回。 */
async function requestChunk(
  chunk: string,
  systemPrompt: string,
  signal: AbortSignal
): Promise<ChunkOutcome> {
  const settings = getSettings();
  try {
    const res = await callChatApi(
      {
        model: settings.model,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: chunk },
        ],
      },
      signal
    );

    if (!res.ok) {
      return {
        ok: false,
        text: '',
        error: friendlyApiError(res.status, res.text, mainLocale()),
        retryable: isRetryableStatus(res.status),
      };
    }

    const content = res.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      // 被截断或为空的回复通常是模型的瞬时抖动。
      return { ok: false, text: '', error: mt('main.translate.emptyResponse'), retryable: true };
    }
    return { ok: true, text: content, retryable: false };
  } catch (err) {
    const message = (err as Error).message;
    // 任务信号只在显式取消时触发；超时另有自己的信号。
    if (signal.aborted) {
      return { ok: false, text: '', error: mt('main.translate.cancelled'), retryable: false };
    }
    return {
      ok: false,
      text: '',
      error: friendlyNetworkError(message, mainLocale()),
      retryable: isRetryableError(message),
    };
  }
}

/** 单个分块，遇瞬时故障时以指数退避重试。 */
async function translateChunkWithRetry(
  chunk: string,
  systemPrompt: string,
  signal: AbortSignal
): Promise<ChunkOutcome> {
  let last: ChunkOutcome = { ok: false, text: '', error: mt('main.translate.failed'), retryable: false };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) {
      return { ok: false, text: '', error: mt('main.translate.cancelled'), retryable: false };
    }

    last = await requestChunk(chunk, systemPrompt, signal);
    if (last.ok) return last;
    if (!last.retryable || attempt === MAX_ATTEMPTS) break;

    const waitMs = backoffDelayMs(attempt);
    log.warn(
      `[translate] chunk attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying in ${waitMs}ms: ${last.error}`
    );
    await delay(waitMs, signal);
  }
  return last;
}

/**
 * 使用当前已保存的设置翻译 `text`。
 *
 * `systemPrompt` 由调用方（界面 / 全局快捷键）组装，其中的术语表已按文本过滤。
 * 长文本会被分块；各分块用单个换行符重新拼接，这也是对照视图再次拆分时的分隔符。
 */
export async function translateViaApi(
  text: string,
  systemPrompt: string,
  opts: TranslateOptions = {}
): Promise<TranslateResult> {
  const settings = getSettings();
  if (!settings.apiKey) {
    return { success: false, error: mt('main.translate.noApiKey') };
  }

  const chunks = chunkText(text);
  if (!chunks.length) {
    return { success: false, error: mt('main.translate.emptyInput') };
  }

  const job = new AbortController();
  activeJobs.add(job);
  const { signal } = job;

  const results: ChunkOutcome[] = new Array(chunks.length);
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  let done = 0;

  opts.onProgress?.(0, chunks.length);

  try {
    await runWithConcurrency(chunks, MAX_CONCURRENT_CHUNKS, async (chunk, index) => {
      const cacheKey = translationCacheKey({
        text: chunk,
        systemPrompt,
        model: settings.model,
        baseUrl,
      });

      const cached = getCachedTranslation(cacheKey);
      if (cached !== undefined) {
        results[index] = { ok: true, text: cached, retryable: false };
      } else {
        const outcome = await translateChunkWithRetry(chunk, systemPrompt, signal);
        results[index] = outcome;
        if (outcome.ok) cacheTranslation(cacheKey, outcome.text);
      }

      done += 1;
      opts.onProgress?.(done, chunks.length);
    });
  } catch (err) {
    log.error('[translate] job failed:', err);
    return { success: false, error: friendlyNetworkError((err as Error).message, mainLocale()) };
  } finally {
    activeJobs.delete(job);
  }

  if (signal.aborted) {
    return { success: false, error: mt('main.translate.cancelled') };
  }

  const failedIndex = results.findIndex((r) => !r?.ok);
  if (failedIndex !== -1) {
    const outcome = results[failedIndex];
    // 告知用户「哪一部分」失败了——启用分块后，单说「翻译失败」无法判断
    // 是首段还是末段出错。
    const where =
      chunks.length > 1
        ? mt('main.translate.chunkPrefix', { index: failedIndex + 1, total: chunks.length })
        : '';
    log.error(`[translate] chunk ${failedIndex + 1}/${chunks.length} failed: ${outcome?.error}`);
    return { success: false, error: `${where}${outcome?.error ?? mt('main.translate.failed')}` };
  }

  return { success: true, text: results.map((r) => r.text).join('\n') };
}