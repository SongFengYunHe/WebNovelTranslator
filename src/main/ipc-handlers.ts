/**
 * All IPC handlers. File system access, encrypted settings storage, SQLite
 * history, EPUB export, the update check and the OpenAI-compatible HTTP calls
 * all live here, in the main process.
 *
 * Every payload is validated before it reaches an implementation (see
 * `./ipc-validate`). The renderer is sandboxed, but it hosts arbitrary page
 * content in the Browser tab, so these channels are a real trust boundary.
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
  /** Re-register the global hotkey from current settings (after a settings change). */
  reloadHotkey: () => { ok: boolean; reason?: string };
  /** Show a tray-style notification to the user. */
  notify: (title: string, body: string) => void;
}

/** Translate + record to history (single source of truth for every online path). */
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
 * Register an IPC handler with uniform validation-error handling.
 *
 * Each handler validates its own payload, so the implementation body only ever
 * sees a typed value. A rejected payload is logged once here and rethrown,
 * which surfaces as a rejected promise in the renderer instead of a silent
 * no-op that looks like success.
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
  // ---- Popup window control ---------------------------------------------------
  handle('panel:close', () => {
    const mw = ctx.getMainWindow();
    if (mw && !mw.isDestroyed()) mw.hide();
    return true;
  });

  // v3.0.1: native minimize — the window stays on the Taskbar (tray keeps
  // running). No hide()/preventDefault() involved.
  handle('panel:minimize', () => {
    const mw = ctx.getMainWindow();
    if (mw && !mw.isDestroyed()) {
      mw.setSkipTaskbar(false);
      mw.minimize();
    }
    return true;
  });

  // ---- Settings ---------------------------------------------------------------
  handle('settings:get', () => toPublic(getSettings()));

  handle('settings:set', (raw) => updateSettings(validateSaveSettingsPatch(raw)));

  handle('settings:test-connection', async (): Promise<TestConnectionResult> => {
    const settings = getSettings();
    if (!settings.apiKey) {
      return { success: false, message: '尚未配置 API 密钥。' };
    }
    // Probe with a real (tiny) completion instead of GET /models: plenty of
    // OpenAI-compatible endpoints — Azure, Ollama proxies, assorted gateways —
    // do not implement /models and would report a false failure.
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

  // ---- Health ------------------------------------------------------------------
  // Surfaced to the UI so a failed SQLite initialisation is visible instead of
  // silently degrading every history feature into a no-op.
  handle('system:health', () => ({ database: getDatabaseStatus() }));

  // ---- Translation -------------------------------------------------------------
  handle('translate', (raw) =>
    translateAndRecord(validateTranslateRequest(raw), (done, total) => {
      const mw = ctx.getMainWindow();
      if (mw && !mw.isDestroyed()) mw.webContents.send('translate:progress', { done, total });
    })
  );

  // Cancels every in-flight chunk request for the current job. Chunks that
  // already completed stay cached, so retrying afterwards only re-requests the
  // ones that were actually interrupted.
  handle('translate:cancel', () => {
    cancelActiveJobs();
    return true;
  });

  // ---- Glossary CRUD -------------------------------------------------------------
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

  // ---- Translation history (Part A2) -------------------------------------------
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

  // ---- Auto-update (Part A1) -----------------------------------------------------
  handle('update:check', (): Promise<UpdateCheckResult> => checkForUpdates(ctx.getMainWindow));

  handle('update:open-download', () => {
    shell.openExternal(RELEASES_URL);
    return true;
  });

  // Tray "Check for Updates" flow (dialog prompt in the main process).
  handle('update:check-and-prompt', async (): Promise<UpdateCheckResult> => {
    const result = await checkForUpdates(ctx.getMainWindow);
    if (result.available && result.version) {
      await promptForUpdate(ctx.getMainWindow, result.version, () => {
        shell.openExternal(RELEASES_URL);
      });
    }
    return result;
  });

  // ---- Global hotkey (Part A3) -----------------------------------------------------
  handle('hotkey:set', (raw) => {
    updateSettings({ hotkey: validateHotkey(raw) });
    return ctx.reloadHotkey();
  });

  // ---- Offline translation (Part A4) ------------------------------------------------
  handle('offline:status', () => getOfflineStatus());

  /**
   * v3.0.1: runtime model download. `download-model` is the primary channel
   * (wired to the settings checkbox / download button); `offline:download`
   * remains as a backward-compatible alias. Progress streams to the renderer
   * via webContents.send('offline:progress') from the main process (the
   * correct direction for download-progress reporting).
   */
  const startModelDownload = async () => {
    const result = await ensureModel();
    if (result.ok) {
      // Persist the "downloaded" flag so the badge survives restarts.
      updateSettings({ offlineModelDownloaded: true, offlineEnabled: true });
    }
    return getOfflineStatus();
  };

  handle('download-model', () => startModelDownload());

  handle('offline:download', () => startModelDownload());

  handle('offline:disable', () => {
    updateSettings({ offlineEnabled: false });
    // disposeOfflineModel is called lazily by translateOffline's guard; keep the
    // cached pipeline so re-enabling without a re-download still works.
    return getOfflineStatus();
  });

  handle('offline:translate', (raw) => {
    const req = validateTranslateRequest(raw);
    const settings = getSettings();
    return translateOffline(req.text, settings.sourceLang, settings.targetLang, settings.activeGlossaryId);
  });

  // ---- EPUB export (Part A5) --------------------------------------------------------
  handle('epub:export', (raw) => exportEpub(ctx.getMainWindow, validateEpubRequest(raw)));
}