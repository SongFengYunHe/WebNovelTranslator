/**
 * 基于 transformers.js 的可选离线翻译后备方案（A4 部分）。
 *
 * 模型：`Xenova/nllb-200-distilled-600M`（多语言，量化后约 870 MB）。
 *
 * 模型在运行时用原生 Node `fetch` 从 Hugging Face 拉取——安装包从不附带它。文件
 * 流式写入 `<userData>/models/<model-id>/`，字节级进度通过 `offline:progress` 事件
 * 推送到渲染进程。已完成的文件会被跳过，因此下载到一半中断后是续传而非重来。
 *
 * 曾有三处问题被修复，且是这里的承重结构：
 *
 *  1. 权重位于 `onnx/` 之下，因此完整性检查必须查看每个必需的仓库相对路径——
 *     而不是在模型目录根下扫描 `*.onnx` 条目（根下的条目是「目录」`onnx`，永远
 *     匹配不上）。这个 bug 会让已完成的下载被报告为「不完整」。
 *  2. transformers.js 把缓存文件解析为 `path.join(env.cacheDir, '<repo>/<file>')`，
 *     因此 `env.cacheDir`「必须」是 `<userData>/models`。把它指向 `<userData>` 会
 *     让引擎找不到我们已下载的文件，转而重新拉取全部约 870 MB。
 *  3. `@xenova/transformers` 及其原生 ONNX 后端是 devDependencies——发布安装包会
 *     排除它们。`engineAvailable` 如实报告这一点，使界面永远不会引导用户去做一次
 *     它无法使用的下载。
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
import { mt } from '../i18n';

// 在 CJS 输出中保留真正的 `import()`（否则 tsc 会把它改写成 `require()`，
// 而后者在 Node 20 上无法加载 ESM 包 transformers）。
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<any>;

const MODEL_ID = 'Xenova/nllb-200-distilled-600M';

/**
 * Hugging Face 主机。可通过 `WNT_HF_HOST` 覆盖，使模型能从镜像（如
 * `https://hf-mirror.com`）拉取，用于 huggingface.co 不可达的网络。
 */
const HF_HOST = (process.env.WNT_HF_HOST || 'https://huggingface.co').replace(/\/+$/, '');
const HF_BASE = `${HF_HOST}/${MODEL_ID}`;

/** 下载失败时的最大重试次数（离线模型下载健壮性）。 */
const MAX_DOWNLOAD_RETRIES = 3;

/** 并行拉取的文件数。保持较低，以免给 HF 造成负担。 */
const MAX_CONCURRENT_DOWNLOADS = 3;

/** 进度事件节流：至少间隔 200ms 才向渲染进程推送一次，避免淹没 IPC 通道。 */
const PROGRESS_EMIT_INTERVAL_MS = 200;

/**
 * 离线翻译实际运行所必须能解析到的包。`onnxruntime-node` 是 transformers.js 的
 * optionalDependency，因此缺失的原生后端必须被显式探测出来，而不能假定存在。
 */
const ENGINE_PACKAGES = ['@xenova/transformers', 'onnxruntime-node'];

/**
 * transformers.js NLLB 流水线所需的精确文件清单（量化构建）。
 * 用作 Hugging Face API tree 的过滤器，以及该请求失败时的回落列表。
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
  /** 仓库相对路径，例如 "onnx/encoder_model_quantized.onnx"。 */
  path: string;
  /** 字节大小；未知时为 0。 */
  size: number;
  /** 文件由 LFS 承载时，来自 Hugging Face 的 LFS 元数据的 sha256。 */
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

/** NLLB 能理解的 FLORES-200 语言代码。 */
const FLORES_CODES: Record<string, string> = {
  zh: 'zho_Hans',
  en: 'eng_Latn',
  ja: 'jpn_Jpan',
  ko: 'kor_Hang',
};

// ---- 引擎可用性 ------------------------------------------------------------

let engineBundledCache: boolean | null = null;

/**
 * 该构建是否随包携带离线引擎。
 *
 * 解析清单是一次廉价的同步探测，在 asar 归档内也能工作，且不会加载该模块或其
 * 原生后端。
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

// ---- 路径 ------------------------------------------------------------------

/** <userData>/models —— 运行时下载缓存的根目录。 */
function modelsBaseDir(): string {
  return path.join(app.getPath('userData'), 'models');
}

/** <userData>/models/Xenova/nllb-200-distilled-600M */
function modelDir(): string {
  return path.join(modelsBaseDir(), ...MODEL_ID.split('/'));
}

/** 仓库相对路径 -> 本地模型目录内的绝对路径。 */
function localFile(relPath: string): string {
  return path.join(modelDir(), ...relPath.split('/'));
}

/**
 * transformers.js 按 `path.join(env.cacheDir, '<repo>/<file>')` 查找文件，因此缓存
 * 根目录必须是「包含」`Xenova` 文件夹的那个目录——即 `<userData>/models`，正是
 * `modelDir()` 写入的位置。
 */
function modelCacheDir(): string {
  return modelsBaseDir();
}

/**
 * 当每个必需的模型文件都存在且非空时为 true。
 *
 * 检查每个仓库相对路径，而不是扫描目录根：权重位于 `onnx/` 下，而在根层扫描
 * `*.onnx` 什么也匹配不到。
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

/** 文件大小与预期一致时即视为完整。 */
function isFileComplete(f: ModelFile): boolean {
  const stat = fs.statSync(localFile(f.path), { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return false;
  if (!f.size) return stat.size > 0; // 预期大小未知——只要有内容即算数
  return stat.size === f.size;
}

// ---- 状态 ------------------------------------------------------------------

/** 可选监听器，从 main.ts 接入以把进度流推送到渲染进程。 */
let progressListener: ((status: OfflineStatus) => void) | null = null;
export function setOfflineProgressListener(fn: ((status: OfflineStatus) => void) | null): void {
  progressListener = fn;
}

function emitStatus(): void {
  progressListener?.(getOfflineStatus());
}

let lastEmitAt = 0;
/** 在热字节流循环中使用的节流版本。 */
function emitProgress(): void {
  const now = Date.now();
  if (now - lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) return;
  lastEmitAt = now;
  emitStatus();
}

/**
 * 模块状态的唯一事实来源。
 *
 * `downloaded` 完全由磁盘上的文件推导——它过去还会或上一个持久化的
 * `offlineModelDownloaded` 标志，那可能对从未下载完成（或已被删除）的模型宣称
 * 「就绪」。
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

/** 重置瞬时状态（下载失败后 / 禁用时使用）。 */
function resetTransient(): void {
  state.downloading = false;
  state.progress = null;
  state.loadedBytes = null;
  state.totalBytes = null;
  state.error = null;
}

/** 把仓库相对路径解析为它在 Hugging Face 上的下载 URL。 */
function resolveUrl(filePath: string): string {
  return `${HF_BASE}/resolve/main/${encodeURI(filePath)}`;
}

// ---- 文件清单 --------------------------------------------------------------

/**
 * 列出要下载的模型文件。Hugging Face API tree 是事实来源（它带有精确大小，以及
 * LFS 承载权重的 sha256）；若失败，我们回退到静态清单，并通过 HEAD 请求补齐大小。
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
    // 大小（以及完整性检查）在下面通过 HEAD 恢复；sha256 无法从这条路径获得。
    return REQUIRED_MODEL_FILES.map((p) => ({ path: p, size: 0 }));
  }
}

// ---- 完整性 ----------------------------------------------------------------

/** 流式 sha256，因此对 400 MB 权重文件求哈希绝不会阻塞主进程。 */
async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * 在把新写入的文件移入正式位置前校验它。
 *
 * 大小总是检查；sha256 在 Hugging Face 提供时检查（LFS 承载的权重）。续传时对
 * 磁盘上已有的文件只做大小校验——每次启动都对约 870 MB 求哈希，比它可能捕获的
 * 损坏更糟。
 */
async function verifyDownloaded(file: string, f: ModelFile): Promise<void> {
  const actualSize = fs.statSync(file).size;
  if (f.size > 0 && actualSize !== f.size) {
    throw new Error(mt('main.offline.sizeMismatch', { expected: f.size, actual: actualSize }));
  }
  if (f.sha256) {
    const actual = await sha256File(file);
    if (actual !== f.sha256) {
      throw new Error(mt('main.offline.hashMismatch'));
    }
  }
}

// ---- 下载 ------------------------------------------------------------------

/** 带重试地把单个文件流式写入 <userData>/models/<model-id>/。 */
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
      /* 忽略 */
    }

    // 本次尝试写入的字节数，这样失败时可以从全局计数器里回滚，
    // 而不是把进度条撑虚。
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
        /* 忽略 */
      }
      if (attempt < MAX_DOWNLOAD_RETRIES) {
        log.warn(
          `[offline] ${f.path} attempt ${attempt}/${MAX_DOWNLOAD_RETRIES} failed, retrying…: ${lastErr.message}`
        );
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw lastErr ?? new Error(mt('main.offline.unknownError'));
}

function updateProgressFromBytes(): void {
  if (state.totalBytes && state.totalBytes > 0) {
    state.progress = Math.min(0.999, (state.loadedBytes ?? 0) / state.totalBytes);
  }
}

/**
 * 运行时下载：把量化的 NLLB 模型从 Hugging Face 流式写入 `<userData>/models/`。
 *
 * 进度的分母是整个模型的大小，其中已缓存的文件计入已完成，因此百分比不会在不同
 * 剩余量的多次尝试之间来回跳动。
 */
async function downloadModelFiles(): Promise<void> {
  fs.mkdirSync(modelDir(), { recursive: true });
  const files = await resolveModelFileList();

  // 通过 HEAD 补齐未知大小（静态回落清单 / tree 返回的异常结果）。
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
          /* 保持 size 为 0 —— 完整性与进度会优雅降级 */
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
    throw new Error(mt('main.offline.incomplete'));
  }
  state.loadedBytes = null;
  state.totalBytes = null;
  state.progress = 1;
}

async function loadTransformers(): Promise<any> {
  const mod = await dynamicImport('@xenova/transformers');
  // 必须是「包含」模型 id 目录的那个文件夹，这样引擎才能找到本模块已下载的
  // 文件，而不是重新拉取。
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
 * 确保模型已下载且流水线已预热。按需调用（IPC `download-model` /
 * `offline:download`），并在离线翻译前隐式调用。
 *
 * 当引擎不在本构建中时直接拒绝：为一个无法运行的特性去拉取约 870 MB，比给出一
 * 条无用的错误消息更糟。
 */
export async function ensureModel(): Promise<{ ok: boolean; error?: string }> {
  if (!isEngineBundled()) {
    return { ok: false, error: mt('main.offline.engineMissing') };
  }
  if (state.pipeline) {
    return { ok: true };
  }
  if (state.downloading) {
    return { ok: false, error: mt('main.offline.downloading') };
  }

  state.downloading = true;
  state.error = null;
  emitStatus();
  try {
    if (!modelFilesExist()) {
      await downloadModelFiles();
    }
    if (!modelFilesExist()) {
      throw new Error(mt('main.offline.incomplete'));
    }
    state.downloading = false;
    state.progress = 1;
    state.loadedBytes = null;
    state.totalBytes = null;
    emitStatus();

    // 预热流水线。上面的守卫已保证引擎存在。
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
      else throw lastErr ?? new Error(mt('main.offline.unknownError'));
    } catch (err) {
      // 模型已在磁盘上，但引擎无法启动——如实上报，而不是假装下载成功。
      const msg = (err as Error).message;
      state.error = mt('main.offline.initFailed', { msg });
      log.error('[offline] pipeline warm failed:', err);
      emitStatus();
      return { ok: false, error: state.error };
    }

    log.info('[offline] model ready');
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message || mt('main.offline.unknownError');
    log.error('[offline] model download/load failed:', err);
    state.downloading = false;
    state.progress = null;
    state.loadedBytes = null;
    state.totalBytes = null;
    state.error =
      /network|fetch|ECONNREFUSED|ENOTFOUND|timed? ?out|aborted|503|429/i.test(msg)
        ? mt('main.offline.downloadFailedNetwork')
        : mt('main.offline.downloadFailed', { msg });
    emitStatus();
    return { ok: false, error: state.error };
  }
}

/** 用离线模型翻译 `text`，然后应用术语表。 */
export async function translateOffline(
  text: string,
  sourceLang: string,
  targetLang: string,
  glossaryId: string | null
): Promise<TranslateResult> {
  const settings = getSettings();
  if (!settings.offlineEnabled) {
    return { success: false, error: mt('main.offline.notEnabled') };
  }
  if (!isEngineBundled()) {
    return { success: false, error: mt('main.offline.engineMissing') };
  }
  if (!state.pipeline) {
    const ensured = await ensureModel();
    if (!ensured.ok) return { success: false, error: ensured.error };
    if (!state.pipeline) {
      return { success: false, error: mt('main.offline.notReady') };
    }
  }

  const srcCode = FLORES_CODES[sourceLang];
  const tgtCode = FLORES_CODES[targetLang];
  if (!srcCode || !tgtCode) {
    return { success: false, error: mt('main.offline.langPairUnsupported') };
  }

  try {
    const output = await state.pipeline(text, { src_lang: srcCode, tgt_lang: tgtCode });
    let translated = Array.isArray(output)
      ? output.map((o: any) => o?.translation_text ?? '').join('\n')
      : String(output);
    translated = translated.trim();

    const glossary: Glossary | null = getGlossaryById(glossaryId);
    translated = applyGlossaryToText(translated, glossary);

    // 像在线路径一样记录到历史。
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
    return { success: false, error: mt('main.offline.translateFailed', { msg: (err as Error).message }) };
  }
}

/** 释放流水线（退出 / 禁用离线模式时使用）。 */
export function disposeOfflineModel(): void {
  state.pipeline = null;
  resetTransient();
}

/**
 * 真正加载一次离线引擎（不做推理），供打包校验与冒烟测试调用。
 *
 * 仅凭 `require.resolve` 无法证明引擎真的可用：`@xenova/transformers` 是 ESM
 * 包，它在 asar 或解包目录里能否被加载、原生后端能否解析，只有实际 import
 * 一次才知道。这条探测就是「离线版安装包是否真的能离线翻译」的证据。
 */
export async function probeEngineLoad(): Promise<{ ok: boolean; error?: string }> {
  if (!isEngineBundled()) {
    return { ok: false, error: 'ENGINE_NOT_BUNDLED' };
  }
  try {
    await loadTransformers();
    return { ok: true };
  } catch (err) {
    log.error('[offline] engine load probe failed:', err);
    return { ok: false, error: (err as Error).message };
  }
}