/**
 * Core OpenAI-compatible translation logic.
 *
 * A chapter is split into chunks (see `shared/chunking`), translated with
 * bounded concurrency, and each chunk is retried independently on transient
 * failures. Completed chunks are cached by content hash, which makes retrying
 * after a partial failure cheap: only the chunks that actually failed are
 * re-requested.
 */
import type { TranslateResult } from '../shared/types';
import { friendlyApiError, friendlyNetworkError } from '../shared/api-errors';
import { chunkText } from '../shared/chunking';
import { anySignal, delay, runWithConcurrency } from '../shared/concurrency';
import { MAX_ATTEMPTS, backoffDelayMs, isRetryableError, isRetryableStatus } from '../shared/retry';
import log from './logger';
import { getSettings, normalizeBaseUrl } from './settings';
import { cacheTranslation, getCachedTranslation, translationCacheKey } from './translation-cache';

/** Per-request timeout, independent of the job-level cancellation signal. */
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * Chunks translated in parallel. Deliberately low: provider rate limits are
 * usually per-account, and each chunk already retries on 429.
 */
const MAX_CONCURRENT_CHUNKS = 3;

export interface ChatApiResponse {
  ok: boolean;
  status: number;
  text: string;
  data: any;
}

export interface TranslateOptions {
  /** Reports chunk completion so the UI can show progress. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Result of translating one chunk. `retryable` is internal — it never reaches
 * the renderer, it only decides whether the retry loop continues.
 */
interface ChunkOutcome {
  ok: boolean;
  text: string;
  error?: string;
  retryable: boolean;
}

/** In-flight jobs, so a long chapter can be cancelled from the UI. */
const activeJobs = new Set<AbortController>();

/**
 * Abort every in-flight translation job. Called by the UI's cancel action and
 * by the shutdown path. Idempotent.
 */
export function cancelActiveJobs(): void {
  for (const job of activeJobs) job.abort();
  activeJobs.clear();
}

/** Call `<base>/chat/completions` with the current settings. */
export async function callChatApi(body: unknown, signal?: AbortSignal): Promise<ChatApiResponse> {
  const settings = getSettings();
  const base = normalizeBaseUrl(settings.baseUrl);

  // The request must stop on EITHER a timeout or a job cancellation.
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
      // Non-JSON body (e.g. proxy error page) — keep raw text for the message.
    }
    return { ok: res.ok, status: res.status, text, data };
  } finally {
    clearTimeout(timer);
  }
}

/** One attempt at one chunk. Never throws — failures come back as outcomes. */
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
        error: friendlyApiError(res.status, res.text),
        retryable: isRetryableStatus(res.status),
      };
    }

    const content = res.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      // A truncated or empty reply is usually a transient model hiccup.
      return { ok: false, text: '', error: '模型返回了空内容，请重试。', retryable: true };
    }
    return { ok: true, text: content, retryable: false };
  } catch (err) {
    const message = (err as Error).message;
    // The job signal only fires on an explicit cancel; the timeout has its own.
    if (signal.aborted) {
      return { ok: false, text: '', error: '已取消翻译。', retryable: false };
    }
    return {
      ok: false,
      text: '',
      error: friendlyNetworkError(message),
      retryable: isRetryableError(message),
    };
  }
}

/** One chunk, retried with exponential backoff on transient failures. */
async function translateChunkWithRetry(
  chunk: string,
  systemPrompt: string,
  signal: AbortSignal
): Promise<ChunkOutcome> {
  let last: ChunkOutcome = { ok: false, text: '', error: '翻译失败。', retryable: false };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) {
      return { ok: false, text: '', error: '已取消翻译。', retryable: false };
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
 * Translate `text` using the currently saved settings.
 *
 * `systemPrompt` is composed by the caller (UI / hotkey) and already has the
 * glossary filtered against the text. Long input is chunked; the chunks are
 * rejoined with a single newline, which is the separator the side-by-side view
 * splits on again.
 */
export async function translateViaApi(
  text: string,
  systemPrompt: string,
  opts: TranslateOptions = {}
): Promise<TranslateResult> {
  const settings = getSettings();
  if (!settings.apiKey) {
    return { success: false, error: '尚未配置 API 密钥，请在设置中添加。' };
  }

  const chunks = chunkText(text);
  if (!chunks.length) {
    return { success: false, error: '没有可翻译的内容。' };
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
    return { success: false, error: friendlyNetworkError((err as Error).message) };
  } finally {
    activeJobs.delete(job);
  }

  if (signal.aborted) {
    return { success: false, error: '已取消翻译。' };
  }

  const failedIndex = results.findIndex((r) => !r?.ok);
  if (failedIndex !== -1) {
    const outcome = results[failedIndex];
    // Tell the user WHICH part failed — with chunking in play, "翻译失败" alone
    // gives no idea whether it was the first paragraph or the last.
    const where = chunks.length > 1 ? `第 ${failedIndex + 1}/${chunks.length} 段：` : '';
    log.error(`[translate] chunk ${failedIndex + 1}/${chunks.length} failed: ${outcome?.error}`);
    return { success: false, error: `${where}${outcome?.error ?? '翻译失败。'}` };
  }

  return { success: true, text: results.map((r) => r.text).join('\n') };
}