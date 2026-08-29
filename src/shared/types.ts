/**
 * Shared type definitions used across the Electron main process and the
 * React renderer. Keep this file dependency-free so it can be imported from
 * anywhere without pulling in platform-specific code.
 *
 * Backward compatibility: the on-disk settings/glossary formats from v1.x are
 * preserved. New fields are added as optional/`| undefined` or with defaults.
 */

export type LanguageCode = 'zh' | 'en' | 'ja' | 'ko';

export interface LanguageOption {
  code: string;
  label: string;
}

export interface GlossaryEntry {
  /** The source-language term, e.g. "火球术". */
  source: string;
  /** The target-language term, e.g. "Fireball Technique". */
  target: string;
}

export interface Glossary {
  id: string;
  name: string;
  entries: GlossaryEntry[];
}

/** Providers that ship a one-click preset (all OpenAI-compatible). */
export type ProviderId = 'custom' | 'deepseek' | 'kimi';

export interface ProviderPreset {
  id: ProviderId;
  /** Human-readable name, kept in English so it reads the same in both locales. */
  name: string;
  baseUrl: string;
  model: string;
}

/** One-click presets for domestic Chinese providers (Part D). */
export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  custom: { id: 'custom', name: 'Custom', baseUrl: '', model: '' },
  deepseek: { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  kimi: { id: 'kimi', name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
};

export const DEFAULT_HOTKEY = 'Ctrl+Shift+Z';

export interface AppSettings {
  /** Stored encrypted in the main process. Never exposed to the renderer. */
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  sourceLang: string;
  targetLang: string;
  activeGlossaryId: string | null;
  /** UI language: 'en' (English) or 'zh' (Simplified Chinese). Defaults to zh. */
  uiLanguage: 'en' | 'zh';
  /** Selected provider preset (drives the UI dropdown, not the request). */
  provider: ProviderId;
  /** Global hotkey used for clipboard translation. */
  hotkey: string;
  /** Offline translation (transformers.js) master switch. */
  offlineEnabled: boolean;
  /** Whether the offline model has been downloaded & cached locally. */
  offlineModelDownloaded: boolean;
  /** Last chapter title recorded for history entries / EPUB export. */
  lastChapterTitle: string;
  /** 自动清理历史：应用启动时删除超过该天数的记录，0 表示关闭。 */
  historyAutoDeleteDays: number;
}

/** Settings as seen by the renderer - the API key is replaced by a boolean flag. */
export type SettingsPublic = Omit<AppSettings, 'apiKey'> & {
  hasApiKey: boolean;
};

/** Patch object accepted by the settings:set IPC handler. */
export interface SaveSettingsPatch {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  sourceLang?: string;
  targetLang?: string;
  activeGlossaryId?: string | null;
  uiLanguage?: 'en' | 'zh';
  provider?: ProviderId;
  hotkey?: string;
  offlineEnabled?: boolean;
  offlineModelDownloaded?: boolean;
  lastChapterTitle?: string;
  historyAutoDeleteDays?: number;
}

export interface TranslateRequest {
  text: string;
  /** Full system prompt already composed in the renderer (glossary + rules). */
  systemPrompt: string;
  /** Optional chapter title recorded with the history entry. */
  chapterTitle?: string;
}

export interface TranslateResult {
  success: boolean;
  text?: string;
  error?: string;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  latencyMs?: number;
}

// ---- Translation history (Part A2) -----------------------------------------

export interface HistoryEntry {
  id: number;
  source_text: string;
  translated_text: string;
  source_lang: string;
  target_lang: string;
  glossary_id: string | null;
  /** Unix epoch milliseconds. */
  timestamp: number;
  chapter_title: string | null;
}

export interface HistoryQuery {
  /** Optional full-text search on source/translated text or chapter title. */
  search?: string;
  /** 1-based page. */
  page: number;
  pageSize: number;
}

export interface HistoryPage {
  items: HistoryEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface HistoryExport {
  kind: 'csv' | 'json';
}

// ---- Offline translation (Part A4) ------------------------------------------

export interface OfflineStatus {
  enabled: boolean;
  /** true while the ~600MB model is downloading. */
  downloading: boolean;
  downloaded: boolean;
  /** 0..1 download progress, null when not downloading. */
  progress: number | null;
  /** Bytes downloaded so far (v3.0.1 runtime download; undefined when idle). */
  loadedBytes?: number;
  /** Total bytes to download; undefined when unknown/idle. */
  totalBytes?: number;
  /** Human-readable error, null when healthy. */
  error: string | null;
}

// ---- Auto-update (Part A1) --------------------------------------------------

export interface UpdateCheckResult {
  /** Whether a newer version is available. */
  available: boolean;
  version?: string;
  /** Non-fatal error message (e.g. network failure / placeholder feed). */
  error?: string;
}

// ---- EPUB export (Part A5) --------------------------------------------------

export interface EpubChapter {
  title: string;
  original: string;
  translated: string;
}

export interface EpubRequest {
  chapters: EpubChapter[];
  defaultTitle: string;
}
