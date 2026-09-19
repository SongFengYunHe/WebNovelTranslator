/**
 * 自动更新检查（A1 部分）——仅通知，绝不自动下载。
 *
 * 使用 electron-updater 的 `generic` provider，指向一个占位 URL。发布源由
 * electron-builder 生成（latest.yml），本应托管在真实的下载页上。在该源存在之前，
 * 检查会优雅失败并写日志，绝不会弹成错误对话框。
 */
import { autoUpdater } from 'electron-updater';
import { app, dialog, type BrowserWindow } from 'electron';
import { UPDATE_FEED_URL } from '../../shared/constants';
import { isNewerVersion } from '../../shared/version';
import type { UpdateCheckResult } from '../../shared/types';
import log from '../logger';
import { mt } from '../i18n';

// 源 URL 派生自 `shared/constants.ts` 中的规范仓库地址，因此 fork 绝不会错误地
// 指向上游项目的发布页。
// 占位地址保护：尚未配置真实更新源时静默跳过检查，仅写日志，不打扰用户。
const isPlaceholderFeed = /example\.com|placeholder|localhost|127\.0\.0\.1/i.test(
  UPDATE_FEED_URL
);

let checking = false;

export function configureAutoUpdater(): void {
  autoUpdater.autoDownload = false; // 仅通知——绝不自动下载。
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URL });

  autoUpdater.on('error', (err) => {
    checking = false;
    log.warn(`[update] check failed (expected until a real feed is published): ${err.message}`);
  });
  autoUpdater.on('update-available', (info) => {
    checking = false;
    log.info(`[update] version ${info.version} is available`);
  });
  autoUpdater.on('update-not-available', () => {
    checking = false;
    log.info('[update] no update available');
  });
}

/**
 * 执行一次检查。返回结构化信息，供设置页渲染自己的状态；当从托盘触发时，会询问
 * 用户是否打开下载页。`getWindow` 用于为对话框指定父窗口。
 */
export async function checkForUpdates(
  getWindow: () => BrowserWindow | null
): Promise<UpdateCheckResult> {
  if (checking) return { available: false, error: mt('main.update.checking') };
  // 占位地址直接静默跳过，避免无意义的报错打扰用户。
  if (isPlaceholderFeed) {
    log.warn('[update] feed URL is a placeholder — skipping update check');
    return { available: false };
  }
  checking = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) {
      checking = false;
      return { available: false, error: mt('main.update.fetchFailed') };
    }
    const info = result.updateInfo;
    const latest = info.version;
    const current = app.getVersion();
    const available = isNewerVersion(latest, current);
    checking = false;
    return { available, version: latest };
  } catch (err) {
    checking = false;
    log.warn('[update] check threw:', (err as Error).message);
    return { available: false, error: mt('main.update.networkFailed') };
  }
}

/** 显示「有新版本」对话框；确认后打开下载页。 */
export async function promptForUpdate(
  getWindow: () => BrowserWindow | null,
  version: string,
  onOpenDownload: () => void
): Promise<void> {
  const win = getWindow();
  const opts = {
    type: 'info' as const,
    title: mt('main.update.availableTitle'),
    message: mt('main.update.availableMessage', { version }),
    buttons: [mt('main.update.openPage'), mt('main.update.cancel')],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  if (response === 0) onOpenDownload();
}
