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
import type {
  Glossary,
  OfflineStatus,
  SettingsPublic,
  SystemHealth,
  TranslateProgress,
} from '../../shared/types';
import type { TranslationKey } from '../i18n';
import { useI18n } from './i18n-context';
import { apiCancelTranslate, apiSystemHealth } from '../services/api';
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
  /** Chunk progress for the running job; null when idle or single-chunk. */
  progress: TranslateProgress | null;
  /** Abort the running translation job. */
  cancelTranslation: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
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
  /** Chunk progress for the running job; null when idle or single-chunk. */
  const [progress, setProgress] = useState<TranslateProgress | null>(null);

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
    const offNotify = window.electronAPI.onNotify((payload) => setToast(payload));
    const offProgress = window.electronAPI.onOfflineProgress((status) => setOfflineStatus(status));
    const offTranslateProgress = window.electronAPI.onTranslateProgress((p) =>
      setProgress(p.total > 1 && p.done < p.total ? p : null)
    );
    return () => {
      offHotkey();
      offNotify();
      offProgress();
      offTranslateProgress();
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
      // The glossary is filtered to the terms this passage actually contains, so
      // a large glossary cannot crowd the chapter out of the prompt.
      const systemPrompt = buildSystemPrompt(sourceLang, targetLang, activeGlossary, text);
      setTranslation({ originalText: text, translatedText: '', translating: true, error: null });
      setProgress(null);

      /** Returns true when the attempt produced a translation. */
      const runOnline = async (): Promise<boolean> => {
        const result = await window.electronAPI.translate({ text, systemPrompt, chapterTitle });
        if (result.success) {
          setTranslation({
            originalText: text,
            translatedText: result.text ?? '',
            translating: false,
            error: null,
            engine: 'online',
          });
          return true;
        }
        setTranslation({
          originalText: text,
          translatedText: '',
          translating: false,
          error: result.error ?? '未知错误。',
        });
        return false;
      };

      const runOffline = async (): Promise<boolean> => {
        const result = await window.electronAPI.offlineTranslate({ text, systemPrompt, chapterTitle });
        if (result.success) {
          setTranslation({
            originalText: text,
            translatedText: result.text ?? '',
            translating: false,
            error: null,
            engine: 'offline',
          });
          return true;
        }
        setTranslation({
          originalText: text,
          translatedText: '',
          translating: false,
          error: result.error ?? '离线翻译失败。',
        });
        return false;
      };

      const engine = settings?.translateEngine ?? 'auto';
      const offlineReady = offlineStatus.enabled && offlineStatus.downloaded;

      try {
        if (engine === 'offline') {
          if (!offlineReady) {
            // Guard here rather than calling through: the main process would
            // start a ~600MB model download as a side effect of translating.
            setTranslation({
              originalText: text,
              translatedText: '',
              translating: false,
              error: t('engine.offlineUnavailable'),
            });
            return;
          }
          await runOffline();
          return;
        }

        if (engine === 'online') {
          await runOnline();
          return;
        }

        // auto: online first when a key exists, otherwise offline; one fallback
        // so a transient API failure still yields a result.
        if (settings?.hasApiKey) {
          const onlineOk = await runOnline();
          if (onlineOk || !offlineReady) return;
          await runOffline();
          return;
        }
        if (offlineReady) {
          await runOffline();
          return;
        }
        // Nothing configured yet — let the online path report the missing key.
        await runOnline();
      } catch (err) {
        setTranslation({
          originalText: text,
          translatedText: '',
          translating: false,
          error: String(err),
        });
      } finally {
        setProgress(null);
      }
    },
    [
      activeGlossary,
      chapterTitle,
      offlineStatus.enabled,
      offlineStatus.downloaded,
      settings?.hasApiKey,
      settings?.translateEngine,
      t,
    ]
  );

  const loadTextIntoTranslator = useCallback((text: string) => {
    setTranslation({ originalText: text, translatedText: '', translating: false, error: null });
    setTab('translate');
  }, []);

  const clearTranslation = useCallback(() => {
    setTranslation(EMPTY_TRANSLATION);
    setProgress(null);
  }, []);

  /** Abort the running job. Completed chunks stay cached, so retrying is cheap. */
  const cancelTranslation = useCallback(async () => {
    await apiCancelTranslate();
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
      progress,
      cancelTranslation,
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
      progress,
      cancelTranslation,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within an AppProvider');
  return ctx;
}
