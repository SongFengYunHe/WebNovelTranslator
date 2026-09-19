/**
 * 基于 Context 的精简 i18n 系统。
 *  - 英文 + 简体中文两份词典。
 *  - `translate(locale, key, params)`，支持 `{param}` 插值。
 *  - 任何缺失条目会先回落到英文，再回落到原始键名。
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
