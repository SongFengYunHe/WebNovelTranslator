/**
 * 基于 Context 的简易 i18n。
 *
 * 提供：
 *  - `locale`   当前界面语言（'en' | 'zh'）
 *  - `setLocale` 切换语言并持久化（localStorage 用于即时启动 +
 *    加密的主进程设置存储）
 *  - `t(key, params?)`  为当前语言翻译一个键
 *
 * 挂载时语言会从 localStorage 同步初始化，以避免闪现错误语言，随后再与持久化的
 * 设置对齐。
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

  // 设置到达后与之对齐。
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
        /* 设置不可用——保留本地默认值 */
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
      /* ignore —— 本次会话仍使用内存中的语言 */
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
