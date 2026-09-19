/**
 * 浮空网文翻译器的主进程入口。
 *
 * 职责：
 *  - 创建无边框弹窗式翻译窗口（v3.0.0——移除了置顶悬浮气泡，改为托盘驱动、
 *    稳定、非浮动的弹窗窗口）。
 *  - 创建带上下文菜单的系统托盘（显示/隐藏、检查更新、退出）。
 *  - 注册全局快捷键（剪贴板翻译）。
 *  - 注册所有 IPC 处理器（窗口控制、术语表 CRUD、设置、历史、翻译代理、
 *    离线引擎、EPUB 导出、更新）。
 *  - 干净退出：销毁每个窗口/视图、关闭 SQLite 数据库、注销快捷键并记录退出。
 *
 * 安全：每个渲染进程窗口都以 `contextIsolation: true`、`nodeIntegration: false`
 * 和 `sandbox: true` 运行。所有 Node/文件/网络操作都在主进程中进行。
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
  nativeTheme,
} from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { registerIpcHandlers, translateAndRecord } from './ipc-handlers';
import { mt } from './i18n';
import log, { logExit } from './logger';
import { getSettings } from './settings';
import { initDatabase, closeDatabase, deleteHistoryOlderThan } from './services/db';
import { cancelActiveJobs } from './translate';
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
  probeEngineLoad,
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
 * 构建 Electron 原生菜单（保留全部默认快捷键），文案跟随当前界面语言。
 * 未显式设置菜单时 Electron 会显示英文的 File/Edit/View/Window/Help。
 */
function buildAppMenu(): Electron.Menu {
  const ok = mt('main.dialog.ok');
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: mt('main.menu.file'),
      submenu: [
        process.platform === 'darwin'
          ? { role: 'close', label: mt('main.menu.closeWindow') }
          : { role: 'quit', label: mt('main.menu.quit') },
      ],
    },
    {
      label: mt('main.menu.edit'),
      submenu: [
        { role: 'undo', label: mt('main.menu.undo') },
        { role: 'redo', label: mt('main.menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: mt('main.menu.cut') },
        { role: 'copy', label: mt('main.menu.copy') },
        { role: 'paste', label: mt('main.menu.paste') },
        { role: 'selectAll', label: mt('main.menu.selectAll') },
      ],
    },
    {
      label: mt('main.menu.view'),
      submenu: [
        { role: 'reload', label: mt('main.menu.reload') },
        { role: 'forceReload', label: mt('main.menu.forceReload') },
        { role: 'toggleDevTools', label: mt('main.menu.toggleDevTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: mt('main.menu.resetZoom') },
        { role: 'zoomIn', label: mt('main.menu.zoomIn') },
        { role: 'zoomOut', label: mt('main.menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: mt('main.menu.toggleFullscreen') },
      ],
    },
    {
      label: mt('main.menu.window'),
      submenu: [
        { role: 'minimize', label: mt('main.menu.minimize') },
        { role: 'close', label: mt('main.menu.closeWindow') },
      ],
    },
    {
      label: mt('main.menu.help'),
      role: 'help',
      submenu: [
        {
          label: mt('main.menu.about'),
          click: () => {
            const opts = {
              type: 'info' as const,
              title: mt('main.dialog.aboutTitle'),
              message: mt('main.appName'),
              detail: mt('main.dialog.aboutDetail', { version: app.getVersion() }),
              buttons: [ok],
            };
            const win = mainWindow;
            if (win && !win.isDestroyed()) void dialog.showMessageBox(win, opts);
            else void dialog.showMessageBox(opts);
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

function setupAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu());
}

// ---- 窗口创建 --------------------------------------------------------------

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
    // v3.0.0：无边框弹窗式窗口（通过自定义标题栏拖动）。
    // 没有操作系统标题栏；标题栏提供拖动区域 + 关闭按钮。
    frame: false,
    title: mt('main.appName'),
    icon: path.join(__dirname, '../../resources/icon.png'),
    // 窗口底色跟随系统深浅色：否则暗色环境下加载完成前会闪一块浅色
    //（与 styles.css 的 --bg 保持一致）。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14171f' : '#f5f6fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true, // 内置浏览器标签页需要它
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../../public/index.html'));

  // v3.0.1：最小化时窗口必须始终出现在任务栏上——
  // 用户通过托盘（显示/隐藏）或关闭按钮显式隐藏它，并通过托盘的「退出」
  // 菜单项退出。
  mainWindow.setSkipTaskbar(false);

  // 渲染进程就绪后显示窗口（弹窗为用户打开）。
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 带小幅去抖地持久化窗口位置与尺寸（E6 部分）。
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

  // 「关闭」是隐藏到托盘，而不是退出。
  mainWindow.on('close', (e: Electron.Event) => {
    if (!isQuitting) {
      e.preventDefault();
      saveMainWindowBounds(mainWindow!.getBounds());
      mainWindow?.hide();
    }
  });

  // v3.0.1：最小化保持原生默认行为（窗口保留在任务栏上，托盘继续运行）。
  // 之前的 blur -> hide() 监听器已被移除——它在窗口失去焦点时触发（包括最小化
  // 时），并移除任务栏条目，把应用只隐藏到托盘中。最小化路径上不存在任何
  // preventDefault()/hide() 逻辑。

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 在系统浏览器中打开外部链接，绝不在应用内打开。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 加固「浏览器」标签页附着的每个 <webview>。标签上的 `webpreferences`
  // 属性由渲染进程提供，因此不可信任——在这里强制使用安全值，并直接拒绝
  // 非 HTTPS 目标。
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;

    const src = params?.src ?? '';
    // `about:blank` 是用户输入 URL 之前的初始状态。
    if (src !== 'about:blank' && !/^https:\/\//i.test(src)) {
      log.warn(`[webview] blocked attach to a non-HTTPS URL: ${src}`);
      event.preventDefault();
    }
  });

  // 可选的自动化冒烟测试（由 `npm run smoke` 使用）。
  // `--smoke-test` 是跨平台的路径：`SMOKE_TEST=1 electron .` 只在 shell 支持行内
  // 环境变量的地方有效，而 npm 在 Windows 上通过 cmd.exe 运行脚本，因此那种写法
  // 在那里会静默失败。
  const isSmokeTest = process.env.SMOKE_TEST === '1' || process.argv.includes('--smoke-test');
  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        // 同时发起 system:health 与 offline:status 两次真实 IPC 往返：既验证
        // preload 桥本身而不只是 React 挂载，也把「本次构建是否包含离线引擎」
        // 写进结果——打包后可直接用它校验标准版 / 离线版各自是否正确。
        const info = await mainWindow!.webContents.executeJavaScript(
          `(async () => {
             const [health, offline] = await Promise.all([
               window.electronAPI.systemHealth(),
               window.electronAPI.offlineStatus()
             ]);
             return JSON.stringify({
               rootChildren: document.getElementById('root')?.children.length ?? -1,
               hasElectronAPI: typeof window.electronAPI === 'object',
               dbOk: health?.database?.ok ?? null,
               offlineEngine: offline?.engineAvailable ?? null
             });
           })()`
        );
        // 冒烟测试结果写入 stdout（供 CI 解析），不使用 console.log。
        // 这里再补一次真实的引擎加载探测：这是「离线版安装包能否真的离线翻译」
        // 的直接证据——仅检查文件是否存在，无法证明 ESM 入口在 asar 解包后
        // 能被 Node 的 ESM 加载器读到。
        const result = JSON.parse(info);
        const engine = await probeEngineLoad();
        result.engineLoads = engine.ok;
        if (!engine.ok) result.engineLoadError = engine.error;
        const payload = JSON.stringify(result);
        // 冒烟测试结果写入 stdout（供 CI 解析），不使用 console.log。
        process.stdout.write('SMOKE_TEST_RESULT ' + payload + '\n');
        // 打包后的 Windows GUI 程序不一定把 stdout 接力到父控制台，因此再落一份
        // 结果文件到 userData 下——打包校验（标准版 / 离线版）与 CI 都可直接读它。
        try {
          fs.writeFileSync(path.join(app.getPath('userData'), 'smoke-result.json'), payload, 'utf-8');
        } catch (writeErr) {
          log.warn('[smoke] failed to write smoke-result.json:', (writeErr as Error).message);
        }
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

// ---- 托盘 ------------------------------------------------------------------

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    // v3.0.0：单个「显示/隐藏」开关即可打开弹窗。
    { label: mt('main.tray.toggle'), click: togglePanel },
    { type: 'separator' },
    {
      label: mt('main.tray.checkUpdates'),
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
              title: mt('main.tray.checkUpdates'),
              message: result.error ? result.error : mt('main.update.upToDate'),
              buttons: [mt('main.dialog.ok')],
            };
            if (win && !win.isDestroyed()) void dialog.showMessageBox(win, msgOpts);
            else void dialog.showMessageBox(msgOpts);
          }
        })();
      },
    },
    { type: 'separator' },
    {
      label: mt('main.tray.quit'),
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray(): void {
  const iconPath = path.join(__dirname, '../../resources/tray.png');
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon);
  tray.setToolTip(mt('main.appName'));
  tray.setContextMenu(buildTrayMenu());
  // v3.0.1：单击始终显示窗口（win.show()），因此它绝不会卡在隐藏状态；
  // 双击保持显示/隐藏切换。
  tray.on('click', showPanel);
  tray.on('double-click', togglePanel);
}

/**
 * 重建所有文案在创建时就已固化的原生 UI（应用菜单 + 托盘菜单）。
 * 用户在设置中切换界面语言后由 IPC 层调用，使语言即时生效而无需重启。
 */
function refreshLocalizedUi(): void {
  setupAppMenu();
  if (tray) {
    tray.setToolTip(mt('main.appName'));
    tray.setContextMenu(buildTrayMenu());
  }
}

// ---- 全局快捷键接线（A3 部分）---------------------------------------------

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
    // 与界面路径同一个实现：翻译 + 落历史只有一处。
    translate: translateAndRecord,
    showResult: showHotkeyResult,
    notify: notifyUser,
  };
}

/** （重新）用当前设置值注册快捷键。 */
function reloadHotkey(): { ok: boolean; reason?: string } {
  const settings = getSettings();
  return registerHotkey(settings.hotkey || 'Ctrl+Shift+Z', makeHotkeyContext());
}

// ---- 离线进度接线（A4 部分）------------------------------------------------

function wireOfflineProgress(): void {
  setOfflineProgressListener((status) => {
    const mw = mainWindow;
    if (mw && !mw.isDestroyed()) mw.webContents.send('offline:progress', status);
  });
}

// ---- 启动：更新、健全性检查、离线续传 ---------------------------------------

function checkForUpdatesOnStartup(): void {
  // 等应用稳定后再发起网络请求。
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

/** E7 部分：确认数据目录存在，并在首次运行时提醒配置 API 密钥。 */
function startupSanityCheck(): void {
  // initDatabase() 同时保证 <userData>/translator-data 存在。
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
  if (
    settings.offlineEnabled &&
    offline.engineAvailable &&
    !offline.downloaded &&
    !offline.downloading
  ) {
    // 用户在上一次会话中已选择启用离线模式；趁应用正在运行续传下载。
    // 当本构建没有离线引擎时完全跳过——没有引擎也就无从运行。
    log.info('[startup] offline mode enabled but model missing — starting download');
    void ensureModel();
  }
}

// ---- 干净退出（E2 部分 / 零残留退出）---------------------------------------

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
    cancelActiveJobs();
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
        /* 忽略 */
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

// ---- 应用生命周期 -----------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showPanel);

  app.whenReady().then(() => {
    log.info(`[startup] v${app.getVersion()} on ${process.platform} ${process.arch}`);
    configureAutoUpdater();

    // 原生菜单按当前界面语言构建。
    setupAppMenu();

    registerIpcHandlers({
      getMainWindow: () => mainWindow,
      reloadHotkey,
      notify: notifyUser,
      refreshLocalizedUi,
    });

    createMainWindow();
    createTray();
    wireOfflineProgress();

    // 全局快捷键（A3 部分）。
    const hotkeyResult = reloadHotkey();
    if (!hotkeyResult.ok) {
      // 快捷键注册失败：同时弹出提醒与托盘通知，应用不会崩溃。
      // `hotkeyResult.reason` 已按当前界面语言生成（见 ./hotkey.ts）。
      log.warn(`[startup] hotkey registration failed: ${hotkeyResult.reason}`);
      const reason = hotkeyResult.reason ?? mt('main.hotkey.registerFailed');
      trackTimer(
        setTimeout(() => {
          notifyUser(mt('main.hotkey.conflictTitle'), reason);
          const opts = {
            type: 'warning' as const,
            title: mt('main.hotkey.conflictTitle'),
            message: reason,
            buttons: [mt('main.dialog.ok')],
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

// 即使所有窗口都被隐藏，也让应用在托盘中保持存活。
app.on('window-all-closed', () => {
  // 有意什么都不做：应用驻留在系统托盘中。
});

// macOS：点击 Dock 图标（或重新启动应用）时唤出面板。窗口通常只是被隐藏到托盘，
// 因此优先复用；只有在它确实已被销毁时才重建。
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) showPanel();
  else createMainWindow();
});

// E2 部分：干净退出——结束所有后台进程并记录状态。
app.on('before-quit', () => {
  // 确保窗口的 `close` 处理器不会取消这次退出。
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
