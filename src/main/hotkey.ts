/**
 * Global hotkey + clipboard translation (Part A3).
 *
 * Flow:
 *   1. A global shortcut (default `Ctrl+Shift+Z`, configurable) is registered.
 *   2. When pressed, the currently focused (external) app has text selected;
 *      we send a Ctrl+C keystroke to it, wait for the clipboard to change,
 *      then read the copied text.
 *   3. The text is translated with the current settings and the result is
 *      pushed to the main panel so it stays visible above the browser.
 *
 * Simulating Ctrl+C cross-platform without a native module is fragile, so on
 * Windows we use a tiny PowerShell SendKeys one-liner (no binary dependency,
 * unlike robotjs). On other platforms we fall back to reading whatever is
 * already on the clipboard.
 */
import { clipboard, globalShortcut, type BrowserWindow } from 'electron';
import { execFile } from 'child_process';
import type { TranslateRequest, TranslateResult } from '../shared/types';
import log from './logger';

export interface HotkeyContext {
  /** Translate text with current settings + prompt. */
  translate: (req: TranslateRequest) => Promise<TranslateResult>;
  /** Present the result in the floating panel / main window. */
  showResult: (original: string, translated: string) => void;
  /** Surface a non-fatal message to the user. */
  notify: (title: string, body: string) => void;
}

let currentAccelerator: string | null = null;
let hotkeyCtx: HotkeyContext | null = null;

/** True when running on Windows (the only platform we simulate Ctrl+C on). */
const isWindows = process.platform === 'win32';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send a Ctrl+C keystroke to the focused (foreground) window via PowerShell. */
function simulateCopy(): Promise<void> {
  return new Promise((resolve) => {
    if (!isWindows) {
      resolve();
      return;
    }
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")',
    ];
    execFile('powershell.exe', args, { windowsHide: true }, (err) => {
      if (err) log.warn('[hotkey] SendKeys failed (copy may not happen):', err.message);
      resolve();
    });
  });
}

/**
 * Wait until the clipboard text differs from `before` (or a non-empty value
 * appears), up to `timeoutMs`. Returns the text, or null on timeout.
 */
async function waitForClipboard(before: string, timeoutMs = 2500): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const now = clipboard.readText();
      if (now && now !== before) return now;
    } catch (err) {
      // Clipboard may be locked by another process — poll again.
      log.warn('[hotkey] clipboard read failed, retrying:', (err as Error).message);
    }
    await sleep(80);
  }
  return null;
}

async function handleHotkey(): Promise<void> {
  const ctx = hotkeyCtx;
  if (!ctx) return;

  const before = (() => {
    try {
      return clipboard.readText();
    } catch {
      return '';
    }
  })();

  await simulateCopy();
  const text = await waitForClipboard(before);

  if (!text || !text.trim()) {
    ctx.notify('全局划词', '未检测到选中的文字。请先在其它程序中选中文字，再按快捷键。');
    return;
  }

  try {
    const result = await ctx.translate({ text, systemPrompt: '' });
    // `translate` fills in the prompt internally when empty (hotkey path).
    if (result.success && result.text) {
      ctx.showResult(text, result.text);
    } else {
      ctx.notify('全局划词', result.error ?? '翻译失败，请稍后重试。');
    }
  } catch (err) {
    log.error('[hotkey] translation failed:', err);
    ctx.notify('全局划词', '翻译失败，请查看日志。');
  }
}

/**
 * Register (or re-register) the global hotkey. Returns false when the OS
 * refuses to register it (hotkey conflict / permission), and a human-readable
 * reason. This is surfaced in the UI (Part E3: hotkey-conflict handling).
 */
export function registerHotkey(accelerator: string, ctx: HotkeyContext): { ok: boolean; reason?: string } {
  unregisterHotkey();
  try {
    const ok = globalShortcut.register(accelerator, () => {
      void handleHotkey();
    });
    if (!ok) {
      // 快捷键冲突：给出中文提示，引导用户更换快捷键。
      return { ok: false, reason: '快捷键注册失败，可能被其他应用占用，请在设置中更换快捷键。' };
    }
    currentAccelerator = accelerator;
    hotkeyCtx = ctx;
    log.info(`[hotkey] registered ${accelerator}`);
    return { ok: true };
  } catch (err) {
    log.error('[hotkey] registration error:', err);
    // 注册异常也必须返回 ok:false，主进程据此提示用户而不会崩溃。
    return { ok: false, reason: '快捷键注册失败，可能被其他应用占用，请在设置中更换快捷键。' };
  }
}

/** Unregister the current hotkey (called on settings change / shutdown). */
export function unregisterHotkey(): void {
  if (currentAccelerator) {
    try {
      globalShortcut.unregister(currentAccelerator);
    } catch (err) {
      log.warn('[hotkey] unregister error:', (err as Error).message);
    }
    currentAccelerator = null;
    hotkeyCtx = null;
  }
}

/** True when a hotkey is currently registered. */
export function isHotkeyRegistered(): boolean {
  return currentAccelerator !== null;
}
