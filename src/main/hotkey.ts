/**
 * 全局快捷键 + 剪贴板翻译（A3 部分）。
 *
 * 流程：
 *   1. 注册一个全局快捷键（默认 `Ctrl+Shift+Z`，可配置）。
 *   2. 按下时，当前获得焦点的（外部）应用中有选中的文字；我们向它发送 Ctrl+C
 *      按键，等待剪贴板变化，然后读取复制到的文本。
 *   3. 用当前设置翻译该文本，并把结果推送到主面板，使其保持显示在浏览器之上。
 *
 * 在没有原生模块的情况下模拟跨平台 Ctrl+C 很脆弱，因此在 Windows 上我们用一个
 * 极小的 PowerShell SendKeys 单行命令（不像 robotjs 那样依赖二进制文件）。在其它
 * 平台上，我们回退为读取剪贴板中已有的内容。
 */
import { clipboard, globalShortcut, type BrowserWindow } from 'electron';
import { execFile } from 'child_process';
import type { TranslateRequest, TranslateResult } from '../shared/types';
import log from './logger';
import { mt } from './i18n';

export interface HotkeyContext {
  /** 用当前设置 + 提示词翻译文本。 */
  translate: (req: TranslateRequest) => Promise<TranslateResult>;
  /** 在浮动面板 / 主窗口中展示结果。 */
  showResult: (original: string, translated: string) => void;
  /** 向用户呈现一条非致命消息。 */
  notify: (title: string, body: string) => void;
}

let currentAccelerator: string | null = null;
let hotkeyCtx: HotkeyContext | null = null;

/** 在 Windows 上运行时为 true（唯一模拟 Ctrl+C 的平台）。 */
const isWindows = process.platform === 'win32';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 通过 PowerShell 向获得焦点（前台）的窗口发送 Ctrl+C 按键。 */
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
 * 等待剪贴板文本与 `before` 不同（或出现非空值），最长 `timeoutMs`。返回该文本，
 * 超时则返回 null。
 */
async function waitForClipboard(before: string, timeoutMs = 2500): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const now = clipboard.readText();
      if (now && now !== before) return now;
    } catch (err) {
      // 剪贴板可能被其它进程锁定——稍后再次轮询。
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
    ctx.notify(mt('notify.hotkeyResult'), mt('main.hotkey.noSelection'));
    return;
  }

  try {
    const result = await ctx.translate({ text, systemPrompt: '' });
    // `translate` 在提示词为空时会内部补齐（全局快捷键路径）。
    if (result.success && result.text) {
      ctx.showResult(text, result.text);
    } else {
      ctx.notify(mt('notify.hotkeyResult'), result.error ?? mt('main.hotkey.translateFailed'));
    }
  } catch (err) {
    log.error('[hotkey] translation failed:', err);
    ctx.notify(mt('notify.hotkeyResult'), mt('main.hotkey.translateFailedDetail'));
  }
}

/**
 * 注册（或重新注册）全局快捷键。当操作系统拒绝注册时返回 false（快捷键冲突 /
 * 权限问题）以及一个人类可读的原因。这会呈现到界面上（E3 部分：快捷键冲突处理）。
 */
export function registerHotkey(accelerator: string, ctx: HotkeyContext): { ok: boolean; reason?: string } {
  unregisterHotkey();
  try {
    const ok = globalShortcut.register(accelerator, () => {
      void handleHotkey();
    });
    if (!ok) {
      // 快捷键冲突：给出提示，引导用户更换快捷键。
      return { ok: false, reason: mt('main.hotkey.registerFailed') };
    }
    currentAccelerator = accelerator;
    hotkeyCtx = ctx;
    log.info(`[hotkey] registered ${accelerator}`);
    return { ok: true };
  } catch (err) {
    log.error('[hotkey] registration error:', err);
    // 注册异常也必须返回 ok:false，主进程据此提示用户而不会崩溃。
    return { ok: false, reason: mt('main.hotkey.registerFailed') };
  }
}

/** 注销当前快捷键（设置变更 / 退出时调用）。 */
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

/** 当前已注册快捷键时为 true。 */
export function isHotkeyRegistered(): boolean {
  return currentAccelerator !== null;
}
