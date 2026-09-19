/**
 * 主进程文案翻译。
 *
 * 词典与渲染进程共用（`src/shared/i18n`），语言取自已持久化的设置项
 * `uiLanguage`，因此「设置 → 界面语言」同时作用于原生菜单、托盘、对话框与
 * 翻译错误消息，而不只是界面。
 *
 * `getSettings()` 只在 app ready 之后可靠；在更早的时机调用会回落到默认语言，
 * 而不是让启动流程因取文案失败而中断。
 */
import { translate, type Locale, type TranslationKey } from '../shared/i18n';
import { getSettings } from './settings';

/** 当前界面语言；设置不可用时回落到中文（与默认设置一致）。 */
export function mainLocale(): Locale {
  try {
    return getSettings().uiLanguage === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

/**
 * 主进程侧的 `t()`。每次调用都读取当前语言，因此用户切换语言后无需重启即可生效
 * （原生菜单与托盘由调用方在语言变更时重建）。
 */
export function mt(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate(mainLocale(), key, params);
}

export type { TranslationKey, Locale };