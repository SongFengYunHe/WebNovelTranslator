/**
 * 精简 i18n 内核，主进程与渲染进程共用。
 *  - 英文 + 简体中文两份词典，键由 `en` 定义、`zh` 强制对齐。
 *  - `translate(locale, key, params)`，支持 `{param}` 插值。
 *  - 任何缺失条目会先回落到英文，再回落到原始键名。
 *
 * 放在 `shared/` 是因为主进程（原生菜单、托盘、对话框）也需要取文案；
 * 渲染进程通过 `useI18n()` 消费同一份词典。
 */
import { en } from './en';
import { zh } from './zh';

export type Locale = 'en' | 'zh';
export type TranslationKey = keyof typeof en;
export type Dictionary = Record<TranslationKey, string>;

export const translations: Record<Locale, Dictionary> = { en, zh };

export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>
): string {
  let value = translations[locale]?.[key];
  if (value == null) value = translations.en[key];
  if (value == null) return key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.split(`{${k}}`).join(String(v));
    }
  }
  return value;
}