/**
 * Global app state via React Context:
 *  - settings (public view, no API key)
 *  - glossaries + active glossary
 *  - active tab
 *  - translation state + orchestration (online with offline fallback)
 *  - offline translation status (Part A4)
 *  - transient toasts pushed from the main process (Part E3)
 *
 * 全局状态中枢：集中管理设置、术语表、翻译流程（在线优先、离线兜底）
 * 以及主进程推送的通知/进度事件，供各页面共享。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Glossary, OfflineStatus, SettingsPublic, SystemHealth } from '../../shared/types';
import type { TranslationKey } from '../i18n';
import { apiSystemHealth } from '../services/api';
import { buildSystemPrompt } from '../../shared/prompt-builder';

/** Language options; labels are i18n keys rendered through `t()` in the UI. */
export const LANGUAGES: { code: string; labelKey: TranslationKey }[] = [
  { code: 'zh', labelKey: 'langs.zh' },
  { code: 'en', labelKey: 'langs.en' },
  { code: 'ja', labelKey: 'langs.ja' },
  { code: 'ko', labelKey: 'langs.ko' },
];

export type TabId = 'translate' | 'browser' | 'glossary' | 'history' | 'settings';

export interface TranslationState {
  originalText: string;
  translatedText: string;
  translating: boolean;
  error: string | null;
  /** Which engine produced the result, for display. */
  engine?: 'online' | 'offline';
}

const EMPTY_TRANSLATION: TranslationState = {
  originalText: '',
  translatedText: '',
  translating: false,
  error: null,
};

export interface Toast {
  title: string;
  body: string;
}

interface AppContextValue {
  settings: SettingsPublic | null;
  glossaries: Glossary[];
  activeGlossary: Glossary | null;
  tab: TabId;
  setTab: (t: TabId) => void;
  translation: TranslationState;
  offlineStatus: OfflineStatus;
  /** Main-process subsystem health; null until the first probe resolves. */
  health: SystemHealth | null;
  chapterTitle: string;
  setChapterTitle: (title: string) => void;
  toast: Toast | null;
  refreshSettings: () => Promise<void>;
  refreshGlossaries: () => Promise<void>;
  refreshOfflineStatus: () => Promise<void>;
  translateText: (text: string, sourceLang: string, targetLang: string) => Promise<void>;
  loadTextIntoTranslator: (text: string) => void;
  clearTranslation: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<SettingsPublic | null>(null);
  const [glossaries, setGlossaries] = useState<Glossary[]>([]);
  const [tab, setTab] = useState<TabId>('translate');
  const [translation, setTranslation] = useState<TranslationState>(EMPTY_TRANSLATION);
  const [offlineStatus, setOfflineStatus] = useState<OfflineStatus>({
    enabled: false,
    downloading: false,
    downloaded: false,
    progress: null,
    error: null,
  });
  const [chapterTitle, setChapterTitle] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await window.electronAPI.getSettings());
    } catch {
      /* ignore — settings stay null until a successful reload */
    }
  }, []);

  const refreshGlossaries = useCallback(async () => {
    try {
      setGlossaries(await window.electronAPI.glossaryList());
    } catch {
      /* ignore — the glossary list stays empty until a successful reload */
    }
  }, []);

  const refreshOfflineStatus = useCallback(async () => {
    try {
      setOfflineStatus(await window.electronAPI.offlineStatus());
    } catch {
      /* ignore — offline status stays at its defaults */
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await apiSystemHealth());
    } catch {
      /* ignore — health stays null, so no banner is shown */
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      refreshSettings(),
      refreshGlossaries(),
      refreshOfflineStatus(),
      refreshHealth(),
    ]);
  }, [refreshSettings, refreshGlossaries, refreshOfflineStatus, refreshHealth]);

  // Main-process → renderer events.
  useEffect(() => {
    const offHotkey = window.electronAPI.onHotkeyResult(({ original, translated }) => {
      setTranslation({
        originalText: original,
        translatedText: translated,
        translating: false,
        error: null,
        engine: 'online',
      });
      setTab('translate');
    });
    const offNotify = window.electronAPI.onNotify((t) => setToast(t));
    const offProgress = window.electronAPI.onOfflineProgress((status) => setOfflineStatus(status));
    return () => {
      offHotkey();
      offNotify();
      offProgress();
    };
  }, []);

  // Auto-dismiss toasts.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const activeGlossary = useMemo(
    () => glossaries.find((g) => g.id === settings?.activeGlossaryId) ?? null,
    [glossaries, settings]
  );

  const translateText = useCallback(
    async (text: string, sourceLang: string, targetLang: string) => {
      const systemPrompt = buildSystemPrompt(sourceLang, targetLang, activeGlossary);
      setTranslation({ originalText: text, translatedText: '', translating: true, error: null });

      const runOnline = async () => {
        const result = await window.electronAPI.translate({ text, systemPrompt, chapterTitle });
        if (result.success) {
          setTranslation({
            originalText: text,
            translatedText: result.text ?? '',
            translating: false,
            error: null,
            engine: 'online',
          });
        } else {
          setTranslation({
            originalText: text,
            translatedText: '',
            translating: false,
            error: result.error ?? '未知错误。',
          });
        }
      };

      const runOffline = async () => {
        const result = await window.electronAPI.offlineTranslate({ text, systemPrompt, chapterTitle });
        if (result.success) {
          setTranslation({
            originalText: text,
            translatedText: result.text ?? '',
            translating: false,
            error: null,
            engine: 'offline',
          });
        } else {
          setTranslation({
            originalText: text,
            translatedText: '',
            translating: false,
            error: result.error ?? '离线翻译失败。',
          });
        }
      };

      try {
        // Offline is a backup: use it when it's the only option (no API key)
        // or when the user explicitly wants it and has no key.
        if (offlineStatus.enabled && offlineStatus.downloaded && !settings?.hasApiKey) {
          await runOffline();
        } else {
          await runOnline();
        }
      } catch (err) {
        setTranslation({
          originalText: text,
          translatedText: '',
          translating: false,
          error: String(err),
        });
      }
    },
    [activeGlossary, chapterTitle, offlineStatus.enabled, offlineStatus.downloaded, settings?.hasApiKey]
  );

  const loadTextIntoTranslator = useCallback((text: string) => {
    setTranslation({ originalText: text, translatedText: '', translating: false, error: null });
    setTab('translate');
  }, []);

  const clearTranslation = useCallback(() => {
    setTranslation(EMPTY_TRANSLATION);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      settings,
      glossaries,
      activeGlossary,
      tab,
      setTab,
      translation,
      offlineStatus,
      health,
      chapterTitle,
      setChapterTitle,
      toast,
      refreshSettings,
      refreshGlossaries,
      refreshOfflineStatus,
      translateText,
      loadTextIntoTranslator,
      clearTranslation,
    }),
    [
      settings,
      glossaries,
      activeGlossary,
      tab,
      translation,
      offlineStatus,
      health,
      chapterTitle,
      toast,
      refreshSettings,
      refreshGlossaries,
      refreshOfflineStatus,
      translateText,
      loadTextIntoTranslator,
      clearTranslation,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within an AppProvider');
  return ctx;
}
