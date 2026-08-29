/**
 * Simple context-based i18n.
 *
 * Provides:
 *  - `locale`   current UI language ('en' | 'zh')
 *  - `setLocale` switches the language and persists it (localStorage for
 *    instant startup + the encrypted main-process settings store)
 *  - `t(key, params?)`  translates a key for the current locale
 *
 * On mount the locale is initialised synchronously from localStorage to avoid
 * a flash of the wrong language, then reconciled with the persisted setting.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { translate, type Locale, type TranslationKey } from '../i18n';

const STORAGE_KEY = 'ui-locale';

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readInitialLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'zh' || stored === 'en' ? stored : 'zh';
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale);

  // Reconcile with the persisted setting once it arrives.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        if (settings.uiLanguage === 'zh' || settings.uiLanguage === 'en') {
          setLocaleState(settings.uiLanguage);
          localStorage.setItem(STORAGE_KEY, settings.uiLanguage);
        }
      })
      .catch(() => {
        /* settings unavailable - keep the local default */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback(async (next: Locale) => {
    setLocaleState(next);
    localStorage.setItem(STORAGE_KEY, next);
    try {
      await window.electronAPI.saveSettings({ uiLanguage: next });
    } catch {
      /* ignore — the in-memory locale still applies for this session */
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale]
  );

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within an I18nProvider');
  return ctx;
}
