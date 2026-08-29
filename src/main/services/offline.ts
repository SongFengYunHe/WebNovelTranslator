/**
 * Optional offline translation backup (Part A4) via transformers.js.
 *
 *  - Model: Xenova/nllb-200-distilled-600M (multilingual, ~600MB quantized).
 *  - v3.0.1 runtime download: model files are fetched from Hugging Face with
 *    plain Node.js `fetch` the moment the user enables offline mode — the
 *    installer never ships them. Files are streamed via `stream/pipeline`
 *    into a `fs.createWriteStream` under <userData>/models/<model-id>/, with
 *    byte-level progress pushed to the renderer through the 'offline:progress'
 *    event (this is the "download-progress" reporting the UI shows as
 *    "下载模型中: 200MB / 600MB").
 *  - Already-complete files are skipped, so a half-finished download resumes
 *    after a restart instead of restarting from zero.
 *  - transformers.js is imported lazily (ESM-only package, kept out of tsc's
 *    CJS transpile via `new Function`) and is used ONLY to run the model. The
 *    download path never depends on it, so no build-time check or hardcoded
 *    "engine not packaged" error can block the download button.
 *  - Glossary is applied to the raw model output via simple string replacement
 *    (the NLLB model is not glossary-aware).
 *
 * NOTE: if huggingface.co is unreachable, the download fails with a friendly
 * error and online translation keeps working.
 */
import path from 'path';
import fs from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { app } from 'electron';
import type { Glossary, OfflineStatus, TranslateResult } from '../../shared/types';
import { applyGlossaryToText } from '../../shared/prompt-builder';
import { getSettings } from '../settings';
import { getGlossaryById } from './glossary';
import { insertHistory } from './db';
import log from '../logger';

// Keeps a real `import()` in CJS output (tsc would otherwise rewrite it into a
// `require()` which cannot load the ESM transformers package on Node 20).
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<any>;

const MODEL_ID = 'Xenova/nllb-200-distilled-600M';
const HF_BASE = `https://huggingface.co/${MODEL_ID}`;

/** 下载失败时的最大重试次数（离线模型下载健壮性）。 */
const MAX_DOWNLOAD_RETRIES = 3;

/** 进度事件节流：至少间隔 200ms 才向渲染进程推送一次，避免淹没 IPC 通道。 */
const PROGRESS_EMIT_INTERVAL_MS = 200;

/**
 * The exact files the transformers.js NLLB pipeline needs (quantized build).
 * Used as the filter for the Hugging Face API tree and as the fallback list
 * when that request fails.
 */
const REQUIRED_MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'sentencepiece.bpe.model',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_quantized.onnx',
];

interface OfflineModuleState {
  downloading: boolean;
  downloaded: boolean;
  progress: number | null;
  loadedBytes: number | null;
  totalBytes: number | null;
  error: string | null;
  pipeline: any | null;
}

const state: OfflineModuleState = {
  downloading: false,
  downloaded: false,
  progress: null,
  loadedBytes: null,
  totalBytes: null,
  error: null,
  pipeline: null,
};

/** FLORES-200 language codes understood by NLLB. */
const FLORES_CODES: Record<string, string> = {
  zh: 'zho_Hans',
  en: 'eng_Latn',
  ja: 'jpn_Jpan',
  ko: 'kor_Hang',
};

/** <userData>/models — the runtime download cache root. */
function modelsBaseDir(): string {
  return path.join(app.getPath('userData'), 'models');
}

/** <userData>/models/Xenova/nllb-200-distilled-600M/... */
function modelDir(): string {
  return path.join(modelsBaseDir(), ...MODEL_ID.split('/'));
}

/**
 * transformers.js cache root. Pointing `env.cacheDir` at <userData> makes the
 * engine reuse our <userData>/models/<model-id>/ layout in dev builds.
 */
function modelCacheDir(): string {
  return app.getPath('userData');
}

/** 校验模型文件是否真实存在，避免“标记已下载但文件缺失”的假状态。 */
function modelFilesExist(): boolean {
  try {
    if (!fs.existsSync(modelDir())) return false;
    const entries = fs.readdirSync(modelDir());
    const hasWeights = entries.some((f) => /\.onnx$/i.test(f));
    const hasConfig = entries.some((f) => f === 'config.json');
    return hasWeights && hasConfig;
  } catch {
    return false;
  }
}

/** Optional listener wired from main.ts to stream progress to the renderer. */
let progressListener: ((status: OfflineStatus) => void) | null = null;
export function setOfflineProgressListener(fn: ((status: OfflineStatus) => void) | null): void {
  progressListener = fn;
}

function emitStatus(): void {
  progressListener?.(getOfflineStatus());
}

let lastEmitAt = 0;
/** Throttled variant used inside the hot byte-streaming loop. */
function emitProgress(): void {
  const now = Date.now();
  if (now - lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) return;
  lastEmitAt = now;
  emitStatus();
}

export function getOfflineStatus(): OfflineStatus {
  const settings = getSettings();
  return {
    enabled: settings.offlineEnabled,
    downloading: state.downloading,
    // 启用离线前必须确认模型文件真实存在。
    downloaded:
      (state.downloaded || settings.offlineModelDownloaded) && modelFilesExist(),
    progress: state.progress,
    loadedBytes: state.loadedBytes ?? undefined,
    totalBytes: state.totalBytes ?? undefined,
    error: state.error,
  };
}

/** Reset transient state (used after a failed download / on disable). */
function resetTransient(): void {
  state.downloading = false;
  state.progress = null;
  state.loadedBytes = null;
  state.totalBytes = null;
  state.error = null;
}

/** Resolve a repo-relative path to its download URL on Hugging Face. */
function resolveUrl(filePath: string): string {
  return `${HF_BASE}/resolve/main/${encodeURI(filePath)}`;
}

interface ModelFile {
  /** Repo-relative path, e.g. "onnx/encoder_model_quantized.onnx". */
  path: string;
  /** Size in bytes; 0 when unknown. */
  size: number;
}

/**
 * List the model files to download. The Hugging Face API tree is the source
 * of truth (it also carries exact file sizes); if it fails we fall back to
 * the static REQUIRED_MODEL_FILES list and fill sizes in via HEAD requests.
 */
async function resolveModelFileList(): Promise<ModelFile[]> {
  try {
    const res = await fetch(
      `https://huggingface.co/api/models/${MODEL_ID}/tree/main?recursive=true`,
      { signal: AbortSignal.timeout(30_000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tree = (await res.json()) as { path?: string; size?: number }[];
    const wanted = new Set(REQUIRED_MODEL_FILES);
    const files = tree
      .filter((f) => f && typeof f.path === 'string' && wanted.has(f.path))
      .map((f) => ({ path: f.path as string, size: Number(f.size) || 0 }));
    if (!files.length) throw new Error('tree contained no wanted files');
    return files;
  } catch (err) {
    log.warn('[offline] HF tree request failed, using static file list:', (err as Error).message);
    return REQUIRED_MODEL_FILES.map((p) => ({ path: p, size: 0 }));
  }
}

/** Stream one file to <userData>/models/<model-id>/ with retries. */
async function downloadOneFile(f: ModelFile): Promise<void> {
  const dest = path.join(modelDir(), f.path);
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    // 清理上次中断留下的残留临时文件。
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch(resolveUrl(f.path));
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const expected = f.size || Number(res.headers.get('content-length')) || 0;
      let received = 0;

      // Byte counter: accumulates into the global loadedBytes and pushes
      // throttled progress events to the renderer while streaming to disk.
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          state.loadedBytes = (state.loadedBytes ?? 0) + chunk.length;
          if (state.totalBytes && state.totalBytes > 0) {
            state.progress = Math.min(0.999, state.loadedBytes / state.totalBytes);
          } else if (expected > 0) {
            // No global total (static fallback list): scale by this file.
            state.progress = Math.min(0.999, received / expected);
          }
          emitProgress();
          cb(null, chunk);
        },
      });

      await pipeline(
        Readable.fromWeb(res.body as any),
        counter,
        fs.createWriteStream(tmp)
      );
      fs.renameSync(tmp, dest);
      log.info(`[offline] downloaded ${f.path}`);
      return;
    } catch (err) {
      lastErr = err as Error;
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      if (attempt < MAX_DOWNLOAD_RETRIES) {
        log.warn(
          `[offline] ${f.path} attempt ${attempt}/${MAX_DOWNLOAD_RETRIES} failed, retrying…: ${lastErr.message}`
        );
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw lastErr ?? new Error('未知错误');
}

/**
 * The v3.0.1 runtime download: streams the quantized NLLB model from Hugging
 * Face into <userData>/models/. Files that are already fully cached are
 * skipped, so the download resumes after interruptions instead of restarting.
 */
async function downloadModelFiles(): Promise<void> {
  fs.mkdirSync(modelDir(), { recursive: true });
  const files = await resolveModelFileList();

  // Fill in unknown sizes via HEAD (static fallback list / odd tree answers).
  await Promise.all(
    files
      .filter((f) => !f.size)
      .map(async (f) => {
        try {
          const head = await fetch(resolveUrl(f.path), {
            method: 'HEAD',
            signal: AbortSignal.timeout(20_000),
          });
          const len = Number(head.headers.get('content-length'));
          if (head.ok && Number.isFinite(len) && len > 0) f.size = len;
        } catch {
          /* keep size 0 — progress falls back to per-file scaling */
        }
      })
  );

  // Skip files that are already fully cached (resume across restarts).
  const pending = files.filter((f) => {
    const dest = path.join(modelDir(), f.path);
    if (!fs.existsSync(dest)) return true;
    if (!f.size) return false; // exists with unknown size → assume complete
    try {
      return fs.statSync(dest).size !== f.size;
    } catch {
      return true;
    }
  });

  if (pending.length) {
    state.loadedBytes = 0;
    const total = pending.reduce((sum, f) => sum + (f.size || 0), 0);
    state.totalBytes = total > 0 ? total : null;
    state.progress = total > 0 ? 0 : null;
    emitStatus();
  }

  for (const f of pending) {
    await downloadOneFile(f);
  }

  if (!modelFilesExist()) {
    throw new Error('模型文件不完整，请重试下载。');
  }
  state.loadedBytes = null;
  state.totalBytes = null;
  state.progress = 1;
}

async function loadTransformers(): Promise<any> {
  // v3.0.1: no build-time check or hardcoded "engine not packaged" error —
  // the download path (plain Node fetch) never calls this, so nothing here
  // can block the download button. If the ESM package is missing (release
  // builds exclude it to stay under 80MB), the caller logs the failure and
  // online translation keeps working.
  const mod = await dynamicImport('@xenova/transformers');
  // Point downloads + caches at the user-data folder.
  mod.env.cacheDir = modelCacheDir();
  mod.env.allowRemoteModels = true;
  mod.env.remoteHost = 'https://huggingface.co';
  mod.env.progress = (info: { status: string; file: string; progress: number; loaded: number; total: number }) => {
    if (state.downloading && info.status === 'download') {
      state.progress =
        info.total > 0 ? Math.min(0.999, (info.loaded || 0) / info.total) : null;
      emitStatus();
    }
  };
  return mod;
}

/**
 * Ensure the model is downloaded and the pipeline is warm. Called on demand
 * (IPC `download-model` / `offline:download`) and implicitly before an
 * offline translation.
 */
export async function ensureModel(): Promise<{ ok: boolean; error?: string }> {
  if (state.pipeline) {
    state.downloaded = true;
    return { ok: true };
  }
  if (state.downloading) {
    return { ok: false, error: '模型正在下载中，请稍候…' };
  }

  state.downloading = true;
  state.error = null;
  emitStatus();
  try {
    // 1) Runtime download from Hugging Face — no packaged files required.
    if (!modelFilesExist()) {
      await downloadModelFiles();
    }
    if (!modelFilesExist()) {
      throw new Error('模型文件不完整，请重试下载。');
    }
    state.downloaded = true;
    state.downloading = false;
    state.progress = 1;
    state.loadedBytes = null;
    state.totalBytes = null;
    emitStatus();

    // 2) Warm the pipeline when the transformers.js engine is bundled (dev
    //    builds). In release builds the engine is excluded to keep the
    //    installer under 80MB — the download above still succeeds and offline
    //    translation reports a clear error at translate time.
    try {
      const mod = await loadTransformers();
      let pipe: any = null;
      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
        try {
          pipe = await mod.pipeline('translation', MODEL_ID, { quantized: true });
          break;
        } catch (err) {
          lastErr = err as Error;
          if (attempt < MAX_DOWNLOAD_RETRIES) {
            log.warn(
              `[offline] pipeline warm attempt ${attempt}/${MAX_DOWNLOAD_RETRIES} failed, retrying…: ${lastErr.message}`
            );
            await new Promise((r) => setTimeout(r, 1500 * attempt));
          }
        }
      }
      if (pipe) state.pipeline = pipe;
      else log.warn('[offline] pipeline warm failed:', lastErr);
    } catch (err) {
      log.warn(
        '[offline] engine unavailable after download (release build without transformers.js):',
        (err as Error).message
      );
    }

    log.info('[offline] model ready');
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message || '未知错误';
    log.error('[offline] model download/load failed:', err);
    state.downloading = false;
    state.progress = null;
    state.loadedBytes = null;
    state.totalBytes = null;
    state.error =
      /network|fetch|ECONNREFUSED|ENOTFOUND|timed? ?out|aborted|503|429/i.test(msg)
        ? '离线模型下载失败，请检查网络后重试。'
        : `离线模型下载失败：${msg}`;
    emitStatus();
    return { ok: false, error: state.error };
  }
}

/** Translate `text` with the offline model, then apply the glossary. */
export async function translateOffline(
  text: string,
  sourceLang: string,
  targetLang: string,
  glossaryId: string | null
): Promise<TranslateResult> {
  const settings = getSettings();
  if (!settings.offlineEnabled) {
    return { success: false, error: '离线翻译未启用，请在设置中开启。' };
  }
  if (!state.pipeline) {
    const ensured = await ensureModel();
    if (!ensured.ok) return { success: false, error: ensured.error };
    if (!state.pipeline) {
      // Release builds ship without the transformers.js engine (size budget).
      // The model files are downloaded & cached — this only shows at
      // translate time, it never blocks the download itself.
      return {
        success: false,
        error: '离线翻译引擎未随安装包提供，无法执行离线翻译（模型已就绪，在线翻译不受影响）。',
      };
    }
  }

  const srcCode = FLORES_CODES[sourceLang];
  const tgtCode = FLORES_CODES[targetLang];
  if (!srcCode || !tgtCode) {
    return { success: false, error: '该语言对暂不支持离线翻译（仅支持中/英/日/韩）。' };
  }

  try {
    const output = await state.pipeline(text, { src_lang: srcCode, tgt_lang: tgtCode });
    let translated = Array.isArray(output)
      ? output.map((o: any) => o?.translation_text ?? '').join('\n')
      : String(output);
    translated = translated.trim();

    const glossary: Glossary | null = getGlossaryById(glossaryId);
    translated = applyGlossaryToText(translated, glossary);

    // Record to history like the online path.
    insertHistory({
      sourceText: text,
      translatedText: translated,
      sourceLang,
      targetLang,
      glossaryId,
      chapterTitle: settings.lastChapterTitle || null,
    });

    return { success: true, text: translated };
  } catch (err) {
    log.error('[offline] translation failed:', err);
    return { success: false, error: `离线翻译失败：${(err as Error).message}` };
  }
}

/** Free the pipeline (used on shutdown / when disabling offline mode). */
export function disposeOfflineModel(): void {
  state.pipeline = null;
  resetTransient();
}

export { modelCacheDir };
