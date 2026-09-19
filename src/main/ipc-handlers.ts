/**
 * 所有 IPC 处理器。文件系统访问、加密设置存储、SQLite 历史、EPUB 导出、
 * 更新检查以及 OpenAI 兼容的 HTTP 调用都位于此处——主进程中。
 *
 * 每个载荷在到达实现之前都会被校验（见 `./ipc-validate`）。渲染进程处于沙箱中，
 * 但它会在「浏览器」标签页承载任意页面内容，因此这些通道是真正的信任边界。
 */
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  TestConnectionResult,
  TranslateRequest,
  TranslateResult,
  UpdateCheckResult,
} from '../shared/types';
import log from './logger';
import { RELEASES_URL } from '../shared/constants';
import { friendlyApiError, friendlyNetworkError } from '../shared/api-errors';
import { getSettings, normalizeBaseUrl, toPublic, updateSettings } from './settings';
import { IpcValidationError } from './ipc-validate';
import {
  validateActiveGlossaryId,
  validateEpubRequest,
  validateGlossaryEntries,
  validateGlossaryId,
  validateGlossaryName,
  validateHistoryExport,
  validateHistoryId,
  validateHistoryQuery,
  validateHotkey,
  validateRetentionDays,
  validateSaveSettingsPatch,
  validateTranslateRequest,
} from './ipc-validate';
import {
  createGlossary,
  deleteGlossary,
  loadGlossaries,
  renameGlossary,
  updateGlossaryEntries,
} from './services/glossary';
import {
  allHistory,
  clearHistory,
  deleteHistory,
  deleteHistoryOlderThan,
  getDatabaseStatus,
  insertHistory,
  queryHistory,
} from './services/db';
import { cancelActiveJobs, translateViaApi } from './translate';
import { checkForUpdates, promptForUpdate } from './services/update';
import { ensureModel, getOfflineStatus, translateOffline } from './services/offline';
import { exportEpub } from './services/epub';

export interface IpcContext {
  getMainWindow: () => BrowserWindow | null;
  /** 从当前设置重新注册全局快捷键（设置变更后调用）。 */
  reloadHotkey: () => { ok: boolean; reason?: string };
  /** 向用户显示一条托盘式通知。 */
  notify: (title: string, body: string) => void;
}

/** 翻译并记录到历史（所有在线路径的唯一事实来源）。 */
async function translateAndRecord(
  req: TranslateRequest,
  onProgress?: (done: number, total: number) => void
): Promise<TranslateResult> {
  const settings = getSettings();
  const result = await translateViaApi(req.text, req.systemPrompt, { onProgress });
  if (result.success && result.text) {
    insertHistory({
      sourceText: req.text,
      translatedText: result.text,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      glossaryId: settings.activeGlossaryId,
      chapterTitle: req.chapterTitle?.trim() || settings.lastChapterTitle || null,
    });
  }
  return result;
}

/**
 * 注册一个带统一校验错误处理的 IPC 处理器。
 *
 * 每个处理器自行校验其载荷，因此实现主体只会看到已定型的值。被拒绝的载荷会在
 * 此处记录一次日志并重新抛出，在渲染进程中表现为 rejected promise，而不是看起来
 * 成功的静默空操作。
 */
function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof IpcValidationError) {
        log.warn(`[ipc] ${channel} rejected an invalid payload: ${err.message}`);
      }
      throw err;
    }
  });
}

export function registerIpcHandlers(ctx: IpcContext): void {
  // ---- 弹窗窗口控制 -----------------------------------------------------------
  handle('panel:close', () => {
    const mw = ctx.getMainWindow();
    if (mw && !mw.isDestroyed()) mw.hide();
    return true;
  });

  // v3.0.1：原生最小化——窗口保留在任务栏上（托盘继续运行）。
  // 不涉及 hide()/preventDefault()。
  handle('panel:minimize', () => {
    const mw = ctx.getMainWindow();
    if (mw && !mw.isDestroyed()) {
      mw.setSkipTaskbar(false);
      mw.minimize();
    }
    return true;
  });

  // ---- 设置 -------------------------------------------------------------------
  handle('settings:get', () => toPublic(getSettings()));

  handle('settings:set', (raw) => updateSettings(validateSaveSettingsPatch(raw)));

  handle('settings:test-connection', async (): Promise<TestConnectionResult> => {
    const settings = getSettings();
    if (!settings.apiKey) {
      return { success: false, message: '尚未配置 API 密钥。' };
    }
    // 用一次真实的（极小的）completion 探测，而不是 GET /models：许多
    // OpenAI 兼容端点——Azure、Ollama 代理、各类网关——并未实现 /models，
    // 那样会报告一次误判的失败。
    const base = normalizeBaseUrl(settings.baseUrl);
    const started = Date.now();
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const latencyMs = Date.now() - started;
      if (res.ok) {
        return {
          success: true,
          message: `连接成功（HTTP ${res.status}，模型 ${settings.model}）。`,
          latencyMs,
        };
      }
      const body = await res.text().catch(() => '');
      return { success: false, message: friendlyApiError(res.status, body), latencyMs };
    } catch (err) {
      return {
        success: false,
        message: friendlyNetworkError((err as Error).message),
        latencyMs: Date.now() - started,
      };
    }
  });

  // ---- 健康状态 ----------------------------------------------------------------
  // 呈现给界面，使 SQLite 初始化失败可见，而不是把每项历史功能
  // 静默降级成空操作。
  handle('system:health', () => ({ database: getDatabaseStatus() }));

  // ---- 翻译 -------------------------------------------------------------------
  handle('translate', (raw) =>
    translateAndRecord(validateTranslateRequest(raw), (done, total) => {
      const mw = ctx.getMainWindow();
      if (mw && !mw.isDestroyed()) mw.webContents.send('translate:progress', { done, total });
    })
  );

  // 取消当前任务中每个在途的分块请求。已完成的分块仍留在缓存中，
  // 因此之后重试只会重新请求那些确实被中断的分块。
  handle('translate:cancel', () => {
    cancelActiveJobs();
    return true;
  });

  // ---- 术语表 CRUD -------------------------------------------------------------
  handle('glossary:list', () => loadGlossaries());

  handle('glossary:create', (rawName) => createGlossary(validateGlossaryName(rawName)));

  handle('glossary:rename', (rawId, rawName) =>
    renameGlossary(validateGlossaryId(rawId), validateGlossaryName(rawName))
  );

  handle('glossary:delete', (rawId) => {
    const id = validateGlossaryId(rawId);
    const list = deleteGlossary(id);
    if (getSettings().activeGlossaryId === id) {
      updateSettings({ activeGlossaryId: null });
    }
    return list;
  });

  handle('glossary:update-entries', (rawId, rawEntries) =>
    updateGlossaryEntries(validateGlossaryId(rawId), validateGlossaryEntries(rawEntries))
  );

  handle('glossary:set-active', (rawId) =>
    updateSettings({ activeGlossaryId: validateActiveGlossaryId(rawId) })
  );

  // ---- 翻译历史（A2 部分）-----------------------------------------------------
  handle('history:list', (raw) => queryHistory(validateHistoryQuery(raw)));

  handle('history:delete', (raw) => deleteHistory(validateHistoryId(raw)));

  handle('history:clear', () => clearHistory());

  // 清除指定天数之前的历史记录（历史记录体积管理）。
  handle('history:clear-older', (raw) => deleteHistoryOlderThan(validateRetentionDays(raw)));

  handle('history:export', async (raw) => {
    const req = validateHistoryExport(raw);
    const rows = allHistory();
    if (!rows.length) {
      return { ok: false, error: '没有可导出的记录。' };
    }
    const defaultName = `history-${new Date().toISOString().slice(0, 10)}.${
      req.kind === 'csv' ? 'csv' : 'json'
    }`;
    const win = ctx.getMainWindow();
    const saveOpts = {
      title: req.kind === 'csv' ? '导出历史记录 (CSV)' : '导出历史记录 (JSON)',
      defaultPath: path.join(os.homedir(), 'Downloads', defaultName),
      filters:
        req.kind === 'csv'
          ? [{ name: 'CSV 文件', extensions: ['csv'] }]
          : [{ name: 'JSON 文件', extensions: ['json'] }],
    };
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, saveOpts)
      : await dialog.showSaveDialog(saveOpts);
    if (canceled || !filePath) return { ok: false, error: '已取消导出。' };

    let content: string;
    if (req.kind === 'json') {
      content = JSON.stringify(rows, null, 2);
    } else {
      const esc = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['id', 'timestamp', 'source_lang', 'target_lang', 'chapter_title', 'source_text', 'translated_text'].join(',');
      const lines = rows.map((r) =>
        [r.id, r.timestamp, esc(r.source_lang), esc(r.target_lang), esc(r.chapter_title ?? ''), esc(r.source_text), esc(r.translated_text)].join(',')
      );
      content = [header, ...lines].join('\r\n');
    }
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      log.info(`[history] exported ${rows.length} rows to ${filePath}`);
      return { ok: true, filePath, count: rows.length };
    } catch (err) {
      log.error('[history] export failed:', err);
      return { ok: false, error: `导出失败：${(err as Error).message}` };
    }
  });

  // ---- 自动更新（A1 部分）-----------------------------------------------------
  handle('update:check', (): Promise<UpdateCheckResult> => checkForUpdates(ctx.getMainWindow));

  handle('update:open-download', () => {
    shell.openExternal(RELEASES_URL);
    return true;
  });

  // 托盘「检查更新」流程（对话框提示在主进程中完成）。
  handle('update:check-and-prompt', async (): Promise<UpdateCheckResult> => {
    const result = await checkForUpdates(ctx.getMainWindow);
    if (result.available && result.version) {
      await promptForUpdate(ctx.getMainWindow, result.version, () => {
        shell.openExternal(RELEASES_URL);
      });
    }
    return result;
  });

  // ---- 全局快捷键（A3 部分）----------------------------------------------------
  handle('hotkey:set', (raw) => {
    updateSettings({ hotkey: validateHotkey(raw) });
    return ctx.reloadHotkey();
  });

  // ---- 离线翻译（A4 部分）------------------------------------------------------
  handle('offline:status', () => getOfflineStatus());

  /**
   * v3.0.1：运行时模型下载。`download-model` 是主通道
   * （接入设置里的复选框 / 下载按钮）；`offline:download` 保留为向后兼容的别名。
   * 进度由主进程通过 webContents.send('offline:progress') 流向渲染进程
   * （这是上报下载进度的正确方向）。
   */
  const startModelDownload = async () => {
    const result = await ensureModel();
    if (result.ok) {
      // `downloaded` 由磁盘上的文件推导得出，因此此处只需持久化用户的
      // 意愿。
      updateSettings({ offlineEnabled: true });
    }
    return getOfflineStatus();
  };

  handle('download-model', () => startModelDownload());

  handle('offline:download', () => startModelDownload());

  handle('offline:disable', () => {
    updateSettings({ offlineEnabled: false });
    // disposeOfflineModel 由 translateOffline 的守卫惰性调用；保留已缓存的
    // 流水线，这样重新启用而无需重新下载仍然可用。
    return getOfflineStatus();
  });

  handle('offline:translate', (raw) => {
    const req = validateTranslateRequest(raw);
    const settings = getSettings();
    return translateOffline(req.text, settings.sourceLang, settings.targetLang, settings.activeGlossaryId);
  });

  // ---- EPUB 导出（A5 部分）-----------------------------------------------------
  handle('epub:export', (raw) => exportEpub(ctx.getMainWindow, validateEpubRequest(raw)));
}