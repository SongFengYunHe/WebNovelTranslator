/**
 * Minimal context-based i18n system.
 *  - English + Simplified Chinese dictionaries.
 *  - `translate(locale, key, params)` with `{param}` interpolation.
 *  - Falls back to English, then to the raw key, for any missing entry.
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
