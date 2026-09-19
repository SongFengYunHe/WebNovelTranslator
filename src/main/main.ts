/**
 * Main process entry point for the Floating Web Novel Translator.
 *
 * Responsibilities:
 *  - Create the frameless popup-style translation window (v3.0.0 — the
 *    always-on-top floating bubble was removed in favour of a tray-driven,
 *    stable, non-floating popup window).
 *  - Create the system tray with a context menu (Show/Hide, Check for
 *    Updates, Quit).
 *  - Register the global hotkey (clipboard translation).
 *  - Register all IPC handlers (window control, glossary CRUD, settings,
 *    history, translation proxy, offline engine, EPUB export, updates).
 *  - Clean shutdown: destroy every window/view, close the SQLite DB,
 *    unregister the hotkey, and log the exit.
 *
 * Security: every renderer window runs with `contextIsolation: true`,
 * `nodeIntegration: false` and `sandbox: true`. All Node/file/network
 * operations happen here, in the main process.
 */
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  shell,
  dialog,
  globalShortcut,
} from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { registerIpcHandlers } from './ipc-handlers';
import log, { logExit } from './logger';
import { getSettings } from './settings';
import { getGlossaryById } from './services/glossary';
import { initDatabase, closeDatabase, insertHistory, deleteHistoryOlderThan } from './services/db';
import { buildSystemPrompt } from '../shared/prompt-builder';
import { translateViaApi, abortAllRequests } from './translate';
import {
  registerHotkey,
  unregisterHotkey,
  type HotkeyContext,
} from './hotkey';
import {
  configureAutoUpdater,
  checkForUpdates,
  promptForUpdate,
} from './services/update';
import {
  disposeOfflineModel,
  ensureModel,
  getOfflineStatus,
  setOfflineProgressListener,
} from './services/offline';
import { getMainWindowBounds, saveMainWindowBounds } from './state';
import { RELEASES_URL } from '../shared/constants';
import type { TranslateRequest, TranslateResult } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** 应用专属临时目录（位于系统 tmp），退出时统一清理，绝不写入应用目录。 */
let appTempDir: string | null = null;
function getAppTempDir(): string {
  if (!appTempDir) {
    appTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wnt-'));
  }
  return appTempDir;
}
function cleanupTempDir(): void {
  if (appTempDir) {
    try {
      fs.rmSync(appTempDir, { recursive: true, force: true });
    } catch (err) {
      log.warn('[exit] failed to remove temp dir:', (err as Error).message);
    }
    appTempDir = null;
  }
}

/** 跟踪所有应用级定时器，退出时统一清理，避免残留 setTimeout 拖住进程。 */
const activeTimers = new Set<ReturnType<typeof setTimeout>>();
function trackTimer(t: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  activeTimers.add(t);
  return t;
}
function clearTrackedTimers(): void {
  for (const t of activeTimers) clearTimeout(t);
  activeTimers.clear();
}

/**
 * 将 Electron 原生菜单本地化为中文（保留全部默认快捷键）。
 * 未显式设置菜单时 Electron 会显示英文的 File/Edit/View/Window/Help。
 */
function setupAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        process.platform === 'darwin'
          ? { role: 'close', label: '关闭窗口' }
          : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        {
          label: '关于',
          click: () => {
            const opts = {
              type: 'info' as const,
              title: '关于',
              message: '浮空网文翻译器',
              detail: `版本 ${app.getVersion()}`,
              buttons: ['确定'],
            };
            const win = mainWindow;
            if (win && !win.isDestroyed()) void dialog.showMessageBox(win, opts);
            else void dialog.showMessageBox(opts);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Window creation -------------------------------------------------------

function createMainWindow(): void {
  const saved = getMainWindowBounds();
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 960,
    height: saved?.height ?? 720,
    x: saved?.x,
    y: saved?.y,
    minWidth: 680,
    minHeight: 520,
    show: false,
    // v3.0.0: frameless popup-style window (dragged via the custom header).
    // No OS title bar; the header provides a drag region + close buttons.
    frame: false,
    title: '浮空网文翻译器',
    icon: path.join(__dirname, '../../resources/icon.png'),
    backgroundColor: '#f5f6fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true, // required by the built-in Browser tab
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../../public/index.html'));

  // v3.0.1: the window must always appear on the Taskbar when minimized —
  // the user hides it explicitly via the tray (Show/Hide) or the close
  // button, and quits via the tray "Quit" menu item.
  mainWindow.setSkipTaskbar(false);

  // Show the window once the renderer is ready (popup opens for the user).
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Persist window bounds (Part E6) with a small debounce.
  const scheduleBoundsSave = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = trackTimer(
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          saveMainWindowBounds(mainWindow.getBounds());
        }
      }, 400)
    );
  };
  mainWindow.on('move', scheduleBoundsSave);
  mainWindow.on('resize', scheduleBoundsSave);

  // "Close" hides to the tray instead of quitting.
  mainWindow.on('close', (e: Electron.Event) => {
    if (!isQuitting) {
      e.preventDefault();
      saveMainWindowBounds(mainWindow!.getBounds());
      mainWindow?.hide();
    }
  });

  // v3.0.1: minimizing keeps the native default behavior (window stays on the
  // Taskbar, tray keeps running). The previous blur -> hide() listener was
  // removed — it fired whenever the window lost focus (including on minimize)
  // and removed the Taskbar entry, hiding the app in the tray only. No
  // preventDefault()/hide() logic exists on the minimize path.

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Harden every <webview> the Browser tab attaches. The `webpreferences`
  // attribute on the tag is supplied by the renderer, so it cannot be trusted —
  // force the safe values here and refuse non-HTTPS targets outright.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;

    const src = params?.src ?? '';
    // `about:blank` is the initial state before the user enters a URL.
    if (src !== 'about:blank' && !/^https:\/\//i.test(src)) {
      log.warn(`[webview] blocked attach to a non-HTTPS URL: ${src}`);
      event.preventDefault();
    }
  });

  // Optional automated smoke test (used by `npm run smoke`).
  // The `--smoke-test` flag is the cross-platform path: `SMOKE_TEST=1 electron .`
  // only works where the shell supports inline env vars, but npm runs scripts
  // through cmd.exe on Windows, so that form silently failed there.
  const isSmokeTest = process.env.SMOKE_TEST === '1' || process.argv.includes('--smoke-test');
  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        // Also round-trips one real IPC call (system:health) so the smoke test
        // exercises the preload bridge end to end, not just that React mounted.
        const info = await mainWindow!.webContents.executeJavaScript(
          `(async () => {
             const health = await window.electronAPI.systemHealth();
             return JSON.stringify({
               rootChildren: document.getElementById('root')?.children.length ?? -1,
               hasElectronAPI: typeof window.electronAPI === 'object',
               dbOk: health?.database?.ok ?? null
             });
           })()`
        );
        // 冒烟测试结果写入 stdout（供 CI 解析），不使用 console.log。
        process.stdout.write('SMOKE_TEST_RESULT ' + info + '\n');
      } catch (err) {
        process.stdout.write('SMOKE_TEST_ERROR ' + String(err) + '\n');
      }
      trackTimer(setTimeout(() => app.exit(0), 300));
    });
  }
}

function showPanel(): void {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function togglePanel(): void {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ---- Tray ------------------------------------------------------------------

function createTray(): void {
  const iconPath = path.join(__dirname, '../../resources/tray.png');
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon);
  tray.setToolTip('浮空网文翻译器');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      // v3.0.0: a single "Show/Hide" toggle opens the popup window.
      { label: '显示 / 隐藏面板', click: togglePanel },
      { type: 'separator' },
      {
        label: '检查更新',
        click: () => {
          void (async () => {
            const result = await checkForUpdates(() => mainWindow);
            if (result.available && result.version) {
              await promptForUpdate(() => mainWindow, result.version, () =>
                shell.openExternal(RELEASES_URL)
              );
            } else {
              const win = mainWindow;
              const msgOpts = {
                type: 'info' as const,
                title: '检查更新',
                message: result.error ? result.error : '当前已是最新版本。',
                buttons: ['确定'],
              };
              if (win && !win.isDestroyed()) void dialog.showMessageBox(win, msgOpts);
              else void dialog.showMessageBox(msgOpts);
            }
          })();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  // v3.0.1: single left-click always shows the window (win.show()) so it can
  // never get stuck hidden; double-click keeps the show/hide toggle.
  tray.on('click', showPanel);
  tray.on('double-click', togglePanel);
}

// ---- Global hotkey wiring (Part A3) ----------------------------------------

function buildHotkeyTranslate(): (req: TranslateRequest) => Promise<TranslateResult> {
  return async (req: TranslateRequest) => {
    const settings = getSettings();
    const glossary = getGlossaryById(settings.activeGlossaryId);
    const prompt =
      req.systemPrompt ||
      buildSystemPrompt(settings.sourceLang, settings.targetLang, glossary);
    const result = await translateViaApi(req.text, prompt);
    if (result.success && result.text) {
      insertHistory({
        sourceText: req.text,
        translatedText: result.text,
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        glossaryId: settings.activeGlossaryId,
        chapterTitle: settings.lastChapterTitle || null,
      });
    }
    return result;
  };
}

function showHotkeyResult(original: string, translated: string): void {
  const mw = mainWindow;
  if (!mw || mw.isDestroyed()) return;
  mw.webContents.send('hotkey:result', { original, translated });
  mw.show();
  mw.focus();
}

function notifyUser(title: string, body: string): void {
  const mw = mainWindow;
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send('app:notify', { title, body });
    mw.show();
  }
}

function makeHotkeyContext(): HotkeyContext {
  return {
    translate: buildHotkeyTranslate(),
    showResult: showHotkeyResult,
    notify: notifyUser,
  };
}

/** (Re-)register the hotkey from the current settings value. */
function reloadHotkey(): { ok: boolean; reason?: string } {
  const settings = getSettings();
  return registerHotkey(settings.hotkey || 'Ctrl+Shift+Z', makeHotkeyContext());
}

// ---- Offline progress wiring (Part A4) -------------------------------------

function wireOfflineProgress(): void {
  setOfflineProgressListener((status) => {
    const mw = mainWindow;
    if (mw && !mw.isDestroyed()) mw.webContents.send('offline:progress', status);
  });
}

// ---- Startup: updates, sanity check, offline resume -------------------------

function checkForUpdatesOnStartup(): void {
  // Wait until the app has settled before hitting the network.
  trackTimer(
    setTimeout(() => {
      void (async () => {
        const result = await checkForUpdates(() => mainWindow);
        if (result.available && result.version) {
          await promptForUpdate(() => mainWindow, result.version, () =>
            shell.openExternal(RELEASES_URL)
          );
        }
      })();
    }, 8000)
  );
}

/** Part E7: verify data dir exists and (on first run) remind about the API key. */
function startupSanityCheck(): void {
  // initDatabase() also guarantees <userData>/translator-data exists.
  initDatabase();

  const settings = getSettings();
  // 历史记录自动清理：按设置删除超过 N 天的记录，防止数据库无限增长。
  if (settings.historyAutoDeleteDays > 0) {
    try {
      const removed = deleteHistoryOlderThan(settings.historyAutoDeleteDays);
      if (removed > 0) {
        log.info(`[startup] auto-cleaned ${removed} history records older than ${settings.historyAutoDeleteDays} days`);
      }
    } catch (err) {
      log.warn('[startup] history auto-clean failed:', (err as Error).message);
    }
  }

  const offline = getOfflineStatus();
  if (!settings.apiKey && !settings.offlineEnabled) {
    log.info('[startup] no API key configured yet — onboarding banner will be shown in the UI');
  }
  if (settings.offlineEnabled && !offline.downloaded && !offline.downloading) {
    // The user already opted into offline mode in a previous session; resume
    // the ~600MB download now that the app is running.
    log.info('[startup] offline mode enabled but model missing — starting download');
    void ensureModel();
  }
}

// ---- Clean shutdown (Part E2 / 零残留退出) ----------------------------------

let cleanupDone = false;

function cleanupOnQuit(): void {
  if (cleanupDone) return;
  cleanupDone = true;

  // 1) 保存窗口状态并清理定时器。
  try {
    if (boundsSaveTimer) {
      clearTimeout(boundsSaveTimer);
      boundsSaveTimer = null;
    }
    clearTrackedTimers();
    if (mainWindow && !mainWindow.isDestroyed()) saveMainWindowBounds(mainWindow.getBounds());
  } catch (err) {
    log.warn('[exit] failed to persist window state:', (err as Error).message);
  }

  // 2) 注销全局快捷键（含未追踪的注册项）。
  try {
    unregisterHotkey();
    globalShortcut.unregisterAll();
  } catch (err) {
    log.warn('[exit] error unregistering hotkeys:', (err as Error).message);
  }

  // 3) 中止所有在途网络请求（翻译请求等）。
  try {
    abortAllRequests();
  } catch (err) {
    log.warn('[exit] error aborting requests:', (err as Error).message);
  }

  // 4) 释放离线模型并关闭 SQLite 连接。
  disposeOfflineModel();
  closeDatabase();

  // 5) 销毁所有 BrowserWindow / BrowserView，确保不残留渲染进程。
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      try {
        w.webContents.close();
      } catch {
        /* ignore */
      }
      w.destroy();
    }
  } catch (err) {
    log.warn('[exit] error destroying windows:', (err as Error).message);
  }

  // 6) 清理本次会话产生的临时文件（模型下载临时文件、EPUB 中间产物等）。
  cleanupTempDir();

  // 7) electron-log 的文件写入是同步的（fs.writeFileSync），此处记录最终日志即完成落盘。
  logExit({ reason: 'clean shutdown complete' });

  // 8) 强制以退出码 0 退出，确保不残留任何后台进程。
  try {
    app.exit(0);
  } catch (err) {
    log.warn('[exit] app.exit(0) failed:', (err as Error).message);
  }
}

// ---- App lifecycle ----------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showPanel);

  app.whenReady().then(() => {
    log.info(`[startup] v${app.getVersion()} on ${process.platform} ${process.arch}`);
    configureAutoUpdater();

    // 原生菜单本地化为中文。
    setupAppMenu();

    registerIpcHandlers({
      getMainWindow: () => mainWindow,
      reloadHotkey,
      notify: notifyUser,
    });

    createMainWindow();
    createTray();
    wireOfflineProgress();

    // Global hotkey (Part A3).
    const hotkeyResult = reloadHotkey();
    if (!hotkeyResult.ok) {
      // 快捷键注册失败：同时弹出中文提醒与托盘通知，应用不会崩溃。
      log.warn(`[startup] hotkey registration failed: ${hotkeyResult.reason}`);
      const reason = hotkeyResult.reason ?? '无法注册全局快捷键，请在设置中更换。';
      trackTimer(
        setTimeout(() => {
          notifyUser('快捷键冲突', reason);
          const opts = {
            type: 'warning' as const,
            title: '快捷键冲突',
            message: reason,
            buttons: ['确定'],
          };
          const win = mainWindow;
          if (win && !win.isDestroyed()) void dialog.showMessageBox(win, opts);
          else void dialog.showMessageBox(opts);
        }, 1500)
      );
    }

    startupSanityCheck();
    checkForUpdatesOnStartup();
  });
}

// Keep the app alive in the tray even when all windows are hidden.
app.on('window-all-closed', () => {
  // Intentionally do nothing: the app lives in the system tray.
});

// Part E2: clean exit — kill all background processes and log the status.
app.on('before-quit', () => {
  // Ensure window `close` handlers don't cancel the quit.
  isQuitting = true;
  try {
    cleanupOnQuit();
  } catch (err) {
    log.warn('[exit] cleanup failed:', (err as Error).message);
  }
});

// 兜底：某些路径（例如菜单快捷键触发的退出）可能不经过 before-quit。
app.on('will-quit', () => {
  cleanupOnQuit();
});

app.on('quit', (_e, exitCode) => {
  logExit({ reason: 'app quit', exitCode });
});
