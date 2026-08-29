/**
 * All IPC handlers. File system access, encrypted settings storage, SQLite
 * history, EPUB export, the update check and the OpenAI-compatible HTTP calls
 * all live here, in the main process.
 */
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  EpubRequest,
  GlossaryEntry,
  HistoryExport,
  HistoryQuery,
  SaveSettingsPatch,
  TestConnectionResult,
  TranslateRequest,
  TranslateResult,
  UpdateCheckResult,
} from '../shared/types';
import log from './logger';
import { getSettings, normalizeBaseUrl, toPublic, updateSettings } from './settings';
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
  insertHistory,
  queryHistory,
} from './services/db';
import { translateViaApi } from './translate';
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
async function translateAndRecord(req: TranslateRequest): Promise<TranslateResult> {
  const settings = getSettings();
  const result = await translateViaApi(req.text, req.systemPrompt, { chapterTitle: req.chapterTitle });
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

export function registerIpcHandlers(ctx: IpcContext): void {
  // ---- Popup window control ---------------------------------------------------
  ipcMain.handle('panel:close', () => {
    const mw = ctx.getMainWindow();
    if (mw && !mw.isDestroyed()) mw.hide();
    return true;
  });

  // v3.0.1: native minimize — the window stays on the Taskbar (tray keeps
  // running). No hide()/preventDefault() involved.
  ipcMain.handle('panel:minimize', () => {
    const mw = ctx.getMainWindow();
    if (mw && !mw.isDestroyed()) {
      mw.setSkipTaskbar(false);
      mw.minimize();
    }
    return true;
  });

  // ---- Settings ---------------------------------------------------------------
  ipcMain.handle('settings:get', () => toPublic(getSettings()));

  ipcMain.handle('settings:set', (_e, patch: SaveSettingsPatch) => updateSettings(patch));

  ipcMain.handle('settings:test-connection', async (): Promise<TestConnectionResult> => {
    const settings = getSettings();
    if (!settings.apiKey) {
      return { success: false, message: '尚未配置 API 密钥。' };
    }
    const base = normalizeBaseUrl(settings.baseUrl);
    const started = Date.now();
    try {
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${settings.apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      const latencyMs = Date.now() - started;
      if (res.ok) {
        return { success: true, message: `连接成功（HTTP ${res.status}）。`, latencyMs };
      }
      const body = await res.text().catch(() => '');
      return { success: false, message: `HTTP ${res.status}: ${body.slice(0, 400)}`, latencyMs };
    } catch (err) {
      return {
        success: false,
        message: `连接失败：${(err as Error).message}`,
        latencyMs: Date.now() - started,
      };
    }
  });

  // ---- Translation -------------------------------------------------------------
  ipcMain.handle('translate', (_e, req: TranslateRequest): Promise<TranslateResult> =>
    translateAndRecord(req)
  );

  // ---- Glossary CRUD -------------------------------------------------------------
  ipcMain.handle('glossary:list', () => loadGlossaries());

  ipcMain.handle('glossary:create', (_e, name: string) => createGlossary(name));

  ipcMain.handle('glossary:rename', (_e, id: string, name: string) => renameGlossary(id, name));

  ipcMain.handle('glossary:delete', (_e, id: string) => {
    const list = deleteGlossary(id);
    if (getSettings().activeGlossaryId === id) {
      updateSettings({ activeGlossaryId: null });
    }
    return list;
  });

  ipcMain.handle('glossary:update-entries', (_e, id: string, entries: GlossaryEntry[]) =>
    updateGlossaryEntries(id, entries)
  );

  ipcMain.handle('glossary:set-active', (_e, id: string | null) =>
    updateSettings({ activeGlossaryId: id })
  );

  // ---- Translation history (Part A2) -------------------------------------------
  ipcMain.handle('history:list', (_e, query: HistoryQuery) => queryHistory(query));

  ipcMain.handle('history:delete', (_e, id: number) => deleteHistory(id));

  ipcMain.handle('history:clear', () => clearHistory());

  // 清除指定天数之前的历史记录（历史记录体积管理）。
  ipcMain.handle('history:clear-older', (_e, days: number) =>
    deleteHistoryOlderThan(days)
  );

  ipcMain.handle('history:export', async (_e, req: HistoryExport) => {
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
  ipcMain.handle('update:check', (): Promise<UpdateCheckResult> => checkForUpdates(ctx.getMainWindow));

  ipcMain.handle('update:open-download', () => {
    shell.openExternal('https://github.com/0000110000/floating_translator/releases');
    return true;
  });

  // Tray "Check for Updates" flow (dialog prompt in the main process).
  ipcMain.handle('update:check-and-prompt', async (): Promise<UpdateCheckResult> => {
    const result = await checkForUpdates(ctx.getMainWindow);
    if (result.available && result.version) {
      await promptForUpdate(ctx.getMainWindow, result.version, () => {
        shell.openExternal('https://github.com/0000110000/floating_translator/releases');
      });
    }
    return result;
  });

  // ---- Global hotkey (Part A3) -----------------------------------------------------
  ipcMain.handle('hotkey:set', (_e, accelerator: string) => {
    updateSettings({ hotkey: accelerator });
    return ctx.reloadHotkey();
  });

  // ---- Offline translation (Part A4) ------------------------------------------------
  ipcMain.handle('offline:status', () => getOfflineStatus());

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

  ipcMain.handle('download-model', () => startModelDownload());

  ipcMain.handle('offline:download', () => startModelDownload());

  ipcMain.handle('offline:disable', () => {
    updateSettings({ offlineEnabled: false });
    // disposeOfflineModel is called lazily by translateOffline's guard; keep the
    // cached pipeline so re-enabling without a re-download still works.
    return getOfflineStatus();
  });

  ipcMain.handle('offline:translate', async (_e, req: TranslateRequest) => {
    const settings = getSettings();
    return translateOffline(req.text, settings.sourceLang, settings.targetLang, settings.activeGlossaryId);
  });

  // ---- EPUB export (Part A5) --------------------------------------------------------
  ipcMain.handle('epub:export', (_e, req: EpubRequest) => exportEpub(ctx.getMainWindow, req));
}
