/**
 * Optional offline translation backup (Part A4) via transformers.js.
 *
 * Model: `Xenova/nllb-200-distilled-600M` (multilingual, ~870 MB quantized).
 *
 * The model is fetched at runtime from Hugging Face with plain Node `fetch` —
 * the installer never ships it. Files stream into
 * `<userData>/models/<model-id>/`, with byte-level progress pushed to the
 * renderer through the `offline:progress` event. Already-complete files are
 * skipped, so a half-finished download resumes instead of restarting.
 *
 * THREE things that were broken before and are load-bearing here:
 *
 *  1. The weights live under `onnx/`, so the completeness check must look at
 *     each required repo-relative path — not scan the model directory root for
 *     a `*.onnx` entry (the root entry is the *directory* `onnx`, which never
 *     matched). That bug made a finished download report "incomplete".
 *  2. transformers.js resolves cached files as
 *     `path.join(env.cacheDir, '<repo>/<file>')`, so `env.cacheDir` MUST be
 *     `<userData>/models`. Pointing it at `<userData>` made the engine miss the
 *     files we had already downloaded and re-fetch all ~870 MB.
 *  3. `@xenova/transformers` and its native ONNX backend are devDependencies —
 *     release installers exclude them. `engineAvailable` reports that honestly
 *     so the UI never invites a download it cannot use.
 */
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { app } from 'electron';
import type { Glossary, OfflineStatus, TranslateResult } from '../../shared/types';
import { runWithConcurrency } from '../../shared/concurrency';
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

/**
 * Hugging Face host. Overridable via `WNT_HF_HOST` so the model can be fetched
 * from a mirror (e.g. `https://hf-mirror.com`) on networks where huggingface.co
 * is unreachable.
 */
const HF_HOST = (process.env.WNT_HF_HOST || 'https://huggingface.co').replace(/\/+$/, '');
const HF_BASE = `${HF_HOST}/${MODEL_ID}`;

/** 下载失败时的最大重试次数（离线模型下载健壮性）。 */
const MAX_DOWNLOAD_RETRIES = 3;

/** Files fetched in parallel. Kept low so we are not a bad HF citizen. */
const MAX_CONCURRENT_DOWNLOADS = 3;

/** 进度事件节流：至少间隔 200ms 才向渲染进程推送一次，避免淹没 IPC 通道。 */
const PROGRESS_EMIT_INTERVAL_MS = 200;

/**
 * Packages that must resolve for offline translation to actually run.
 * `onnxruntime-node` is an optionalDependency of transformers.js, so a missing
 * native backend has to be detected explicitly rather than assumed present.
 */
const ENGINE_PACKAGES = ['@xenova/transformers', 'onnxruntime-node'];

/** Shown whenever the build cannot run offline translation at all. */
export const ENGINE_MISSING_MESSAGE =
  '当前安装包未包含离线翻译引擎，无法进行离线翻译（在线翻译不受影响）。';

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

interface ModelFile {
  /** Repo-relative path, e.g. "onnx/encoder_model_quantized.onnx". */
  path: string;
  /** Size in bytes; 0 when unknown. */
  size: number;
  /** sha256 from Hugging Face's LFS metadata, when the file is LFS-backed. */
  sha256?: string;
}

interface OfflineModuleState {
  downloading: boolean;
  progress: number | null;
  loadedBytes: number | null;
  totalBytes: number | null;
  error: string | null;
  pipeline: any | null;
}

const state: OfflineModuleState = {
  downloading: false,
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

// ---- Engine availability ----------------------------------------------------

let engineBundledCache: boolean | null = null;

/**
 * Whether the offline engine ships in this build.
 *
 * Resolving the manifest is a cheap synchronous probe that works inside an asar
 * archive and does not load the module or its native backend.
 */
function isEngineBundled(): boolean {
  if (engineBundledCache === null) {
    engineBundledCache = ENGINE_PACKAGES.every((pkg) => {
      try {
        require.resolve(`${pkg}/package.json`);
        return true;
      } catch {
        return false;
      }
    });
    if (!engineBundledCache) {
      log.info('[offline] engine not bundled in this build — offline translation unavailable');
    }
  }
  return engineBundledCache;
}

// ---- Paths ------------------------------------------------------------------

/** <userData>/models — the runtime download cache root. */
function modelsBaseDir(): string {
  return path.join(app.getPath('userData'), 'models');
}

/** <userData>/models/Xenova/nllb-200-distilled-600M */
function modelDir(): string {
  return path.join(modelsBaseDir(), ...MODEL_ID.split('/'));
}

/** Repo-relative path -> absolute path inside the local model directory. */
function localFile(relPath: string): string {
  return path.join(modelDir(), ...relPath.split('/'));
}

/**
 * transformers.js looks files up as `path.join(env.cacheDir, '<repo>/<file>')`,
 * so the cache root must be the directory that CONTAINS the `Xenova` folder —
 * i.e. `<userData>/models`, exactly where `modelDir()` writes.
 */
function modelCacheDir(): string {
  return modelsBaseDir();
}

/**
 * True when every required model file is present and non-empty.
 *
 * Checks each repo-relative path rather than scanning the directory root: the
 * weights live in `onnx/`, and a root-level `*.onnx` scan matched nothing.
 */
function modelFilesExist(): boolean {
  try {
    return REQUIRED_MODEL_FILES.every((rel) => {
      const stat = fs.statSync(localFile(rel), { throwIfNoEntry: false });
      return stat !== undefined && stat.isFile() && stat.size > 0;
    });
  } catch {
    return false;
  }
}

/** A file counts as complete when its size matches the expected one. */
function isFileComplete(f: ModelFile): boolean {
  const stat = fs.statSync(localFile(f.path), { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return false;
  if (!f.size) return stat.size > 0; // unknown expected size — any content counts
  return stat.size === f.size;
}

// ---- Status -----------------------------------------------------------------

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

/**
 * Single source of truth for the module's state.
 *
 * `downloaded` is derived purely from the files on disk — it used to also OR in
 * a persisted `offlineModelDownloaded` flag, which could claim "ready" for a
 * model that had never finished downloading (or had been deleted).
 */
export function getOfflineStatus(): OfflineStatus {
  const settings = getSettings();
  return {
    enabled: settings.offlineEnabled,
    engineAvailable: isEngineBundled(),
    downloading: state.downloading,
    downloaded: modelFilesExist(),
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

// ---- File list --------------------------------------------------------------

/**
 * List the model files to download. The Hugging Face API tree is the source of
 * truth (it carries exact sizes and, for LFS-backed weights, the sha256); if it
 * fails we fall back to the static list and fill sizes in via HEAD requests.
 */
async function resolveModelFileList(): Promise<ModelFile[]> {
  try {
    const res = await fetch(
      `${HF_HOST}/api/models/${MODEL_ID}/tree/main?recursive=true`,
      { signal: AbortSignal.timeout(30_000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tree = (await res.json()) as {
      path?: string;
      size?: number;
      lfs?: { oid?: string };
    }[];
    const wanted = new Set(REQUIRED_MODEL_FILES);
    const files = tree
      .filter((f) => f && typeof f.path === 'string' && wanted.has(f.path))
      .map((f) => ({
        path: f.path as string,
        size: Number(f.size) || 0,
        sha256: typeof f.lfs?.oid === 'string' ? f.lfs.oid.toLowerCase() : undefined,
      }));
    if (!files.length) throw new Error('tree contained no wanted files');
    if (files.length !== wanted.size) {
      log.warn(`[offline] HF tree returned ${files.length}/${wanted.size} required files`);
    }
    return files;
  } catch (err) {
    log.warn('[offline] HF tree request failed, using static file list:', (err as Error).message);
    // Sizes (and so integrity checks) are recovered via HEAD below; sha256 is
    // not available from this path.
    return REQUIRED_MODEL_FILES.map((p) => ({ path: p, size: 0 }));
  }
}

// ---- Integrity --------------------------------------------------------------

/** Streaming sha256 so hashing a 400 MB weight file never blocks the main process. */
async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Verify a freshly written file before it is moved into place.
 *
 * Size is always checked; sha256 is checked when Hugging Face supplied one
 * (LFS-backed weights). Files that were already on disk are only size-checked
 * during resume — hashing ~870 MB on every launch would be worse than the
 * corruption it might catch.
 */
async function verifyDownloaded(file: string, f: ModelFile): Promise<void> {
  const actualSize = fs.statSync(file).size;
  if (f.size > 0 && actualSize !== f.size) {
    throw new Error(`大小不符（预期 ${f.size} 字节，实际 ${actualSize}）`);
  }
  if (f.sha256) {
    const actual = await sha256File(file);
    if (actual !== f.sha256) {
      throw new Error('校验失败（sha256 不匹配）');
    }
  }
}

// ---- Download ---------------------------------------------------------------

/** Stream one file to <userData>/models/<model-id>/ with retries. */
async function downloadOneFile(f: ModelFile): Promise<void> {
  const dest = localFile(f.path);
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

    // Bytes this attempt contributed, so a failure can be rolled back out of
    // the global counter instead of inflating the progress bar.
    let attemptBytes = 0;

    try {
      const res = await fetch(resolveUrl(f.path));
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          attemptBytes += chunk.length;
          state.loadedBytes = (state.loadedBytes ?? 0) + chunk.length;
          updateProgressFromBytes();
          emitProgress();
          cb(null, chunk);
        },
      });

      await pipeline(Readable.fromWeb(res.body as any), counter, fs.createWriteStream(tmp));
      await verifyDownloaded(tmp, f);
      fs.renameSync(tmp, dest);
      log.info(`[offline] downloaded ${f.path}${f.sha256 ? ' (sha256 verified)' : ''}`);
      return;
    } catch (err) {
      lastErr = err as Error;
      state.loadedBytes = Math.max(0, (state.loadedBytes ?? 0) - attemptBytes);
      updateProgressFromBytes();
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

function updateProgressFromBytes(): void {
  if (state.totalBytes && state.totalBytes > 0) {
    state.progress = Math.min(0.999, (state.loadedBytes ?? 0) / state.totalBytes);
  }
}

/**
 * The runtime download: streams the quantized NLLB model from Hugging Face into
 * `<userData>/models/`.
 *
 * The progress denominator is the size of the WHOLE model, with already-cached
 * files counted as done, so the percentage does not jump around between
 * attempts that have different amounts left to fetch.
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
          /* keep size 0 — integrity and progress degrade gracefully */
        }
      })
  );

  const pending = files.filter((f) => !isFileComplete(f));
  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const pendingBytes = pending.reduce((sum, f) => sum + (f.size || 0), 0);

  state.totalBytes = totalBytes > 0 ? totalBytes : null;
  state.loadedBytes = Math.max(0, totalBytes - pendingBytes);
  updateProgressFromBytes();
  emitStatus();

  await runWithConcurrency(pending, MAX_CONCURRENT_DOWNLOADS, (f) => downloadOneFile(f));

  if (!modelFilesExist()) {
    throw new Error('模型文件不完整，请重试下载。');
  }
  state.loadedBytes = null;
  state.totalBytes = null;
  state.progress = 1;
}

async function loadTransformers(): Promise<any> {
  const mod = await dynamicImport('@xenova/transformers');
  // Must be the folder that CONTAINS the model id directory, so the engine
  // finds the files this module downloaded rather than re-fetching them.
  mod.env.cacheDir = modelCacheDir();
  mod.env.allowRemoteModels = true;
  mod.env.remoteHost = HF_HOST;
  mod.env.progress = (info: {
    status: string;
    file: string;
    progress: number;
    loaded: number;
    total: number;
  }) => {
    if (state.downloading && info.status === 'download') {
      state.progress = info.total > 0 ? Math.min(0.999, (info.loaded || 0) / info.total) : null;
      emitStatus();
    }
  };
  return mod;
}

/**
 * Ensure the model is downloaded and the pipeline is warm. Called on demand
 * (IPC `download-model` / `offline:download`) and implicitly before an offline
 * translation.
 *
 * Refuses outright when the engine is not in this build: fetching ~870 MB for a
 * feature that cannot run would be worse than an unhelpful error message.
 */
export async function ensureModel(): Promise<{ ok: boolean; error?: string }> {
  if (!isEngineBundled()) {
    return { ok: false, error: ENGINE_MISSING_MESSAGE };
  }
  if (state.pipeline) {
    return { ok: true };
  }
  if (state.downloading) {
    return { ok: false, error: '模型正在下载中，请稍候…' };
  }

  state.downloading = true;
  state.error = null;
  emitStatus();
  try {
    if (!modelFilesExist()) {
      await downloadModelFiles();
    }
    if (!modelFilesExist()) {
      throw new Error('模型文件不完整，请重试下载。');
    }
    state.downloading = false;
    state.progress = 1;
    state.loadedBytes = null;
    state.totalBytes = null;
    emitStatus();

    // Warm the pipeline. The engine is guaranteed present by the guard above.
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
      else throw lastErr ?? new Error('引擎初始化失败');
    } catch (err) {
      // The model is on disk but the engine could not start — report it rather
      // than pretending the download succeeded.
      const msg = (err as Error).message;
      state.error = `离线翻译引擎初始化失败：${msg}`;
      log.error('[offline] pipeline warm failed:', err);
      emitStatus();
      return { ok: false, error: state.error };
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
  if (!isEngineBundled()) {
    return { success: false, error: ENGINE_MISSING_MESSAGE };
  }
  if (!state.pipeline) {
    const ensured = await ensureModel();
    if (!ensured.ok) return { success: false, error: ensured.error };
    if (!state.pipeline) {
      return { success: false, error: '离线翻译引擎尚未就绪，请稍后重试。' };
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