/**
 * 全局快捷键 + 剪贴板翻译（A3 部分）。
 *
 * 流程：
 *   1. 注册一个全局快捷键（默认 `Ctrl+Shift+Z`，可配置）。
 *   2. 按下时读取剪贴板中已有的文本——用户先复制要翻译的段落，再按快捷键。
 *   3. 用当前设置翻译该文本，并把结果推送到主面板，使其保持显示在浏览器之上。
 *
 * P5：不再模拟 Ctrl+C 取词。旧实现每次取词都要冷启动 `powershell.exe` 发送
 * SendKeys——约 100–300ms，受执行策略限制（`docs/` 中那份《PowerShell 脚本权限
 * 修复》即为此问题的产物），并且在 macOS/Linux 上完全没有发送按键的分支，等待
 * 剪贴板「变化」必然超时，快捷键形同虚设。
 *
 * 改为直接读剪贴板后：各平台行为一致、零进程启动开销，也不引入任何原生按键模拟
 * 模块（那会让安装包与 CI 背上原生模块 ABI 的包袱）。
 */
import { clipboard, globalShortcut } from 'electron';
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

async function handleHotkey(): Promise<void> {
  const ctx = hotkeyCtx;
  if (!ctx) return;

  // 剪贴板可能被其它进程短暂锁定；读失败只是没内容，不该让快捷键链路抛异常。
  let text = '';
  try {
    text = clipboard.readText();
  } catch (err) {
    log.warn('[hotkey] clipboard read failed:', (err as Error).message);
  }

  if (!text || !text.trim()) {
    ctx.notify(mt('notify.hotkeyResult'), mt('main.hotkey.emptyClipboard'));
    return;
  }

  try {
    // 提示词留空：translateViaApi 会按当前设置与术语表补齐，与界面路径同源。
    const result = await ctx.translate({ text, systemPrompt: '' });
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