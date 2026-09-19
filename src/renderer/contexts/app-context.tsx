/**
 * 通过 React Context 管理全局应用状态：
 *  - 设置（公开视图，不含 API 密钥）
 *  - 术语表 + 当前术语表
 *  - 当前标签页
 *  - 翻译状态 + 编排（在线优先、离线兜底）
 *  - 离线翻译状态（A4 部分）
 *  - 由主进程推送的瞬时 toast（E3 部分）
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

/** 语言选项；其标签是 i18n 键，在界面中通过 `t()` 渲染。 */
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
  /** 产生该结果的引擎，用于显示。 */
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
  /** 主进程子系统健康状况；在首次探测完成前为 null。 */
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
  /** 运行中任务的分块进度；空闲或单分块时为 null。 */
  progress: TranslateProgress | null;
  /** 中止运行中的翻译任务。 */
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
    // 首次探测完成前保持乐观：每次启动都闪现「引擎缺失」错误，比短暂
    // 显示开关更糟。
    engineAvailable: true,
  });
  const [chapterTitle, setChapterTitle] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  /** 运行中任务的分块进度；空闲或单分块时为 null。 */
  const [progress, setProgress] = useState<TranslateProgress | null>(null);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await window.electronAPI.getSettings());
    } catch {
      /* ignore —— 设置保持为 null，直到某次重载成功 */
    }
  }, []);

  const refreshGlossaries = useCallback(async () => {
    try {
      setGlossaries(await window.electronAPI.glossaryList());
    } catch {
      /* ignore —— 术语表列表保持为空，直到某次重载成功 */
    }
  }, []);

  const refreshOfflineStatus = useCallback(async () => {
    try {
      setOfflineStatus(await window.electronAPI.offlineStatus());
    } catch {
      /* ignore —— 离线状态保持其默认值 */
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await apiSystemHealth());
    } catch {
      /* ignore —— 健康状况保持为 null，因此不显示横幅 */
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

  // 主进程 → 渲染进程事件。
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

  // 自动关闭 toast。
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
      // 术语表会过滤为该段落实际包含的术语，这样庞大的术语表才不会
      // 把章节挤出提示词。
      const systemPrompt = buildSystemPrompt(sourceLang, targetLang, activeGlossary, text);
      setTranslation({ originalText: text, translatedText: '', translating: true, error: null });
      setProgress(null);

      /** 该次尝试产出了翻译时返回 true。 */
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
            // 在此处守卫，而不是直接调用：否则主进程会把一次约 870 MB 的
            // 模型下载当作翻译的副作用启动。
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

        // auto：有密钥时先在线，否则离线；允许一次回落，
        // 使瞬时的 API 失败仍能产出结果。
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
        // 尚未配置任何内容——让在线路径报告缺少密钥。
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

  /** 中止运行中的任务。已完成的分块仍留在缓存中，因此重试代价很低。 */
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
