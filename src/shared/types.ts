/**
 * Electron 主进程与 React 渲染进程共享的类型定义。保持此文件无依赖，以便从任何
 * 地方导入而不会引入平台相关代码。
 *
 * 向后兼容：保留 v1.x 的磁盘设置/术语表格式。新增字段以可选/`| undefined` 或带
 * 默认值的形式加入。
 */

export type LanguageCode = 'zh' | 'en' | 'ja' | 'ko';

export interface LanguageOption {
  code: string;
  label: string;
}

export interface GlossaryEntry {
  /** 源语言术语，例如 "火球术"。 */
  source: string;
  /** 目标语言术语，例如 "Fireball Technique"。 */
  target: string;
}

export interface Glossary {
  id: string;
  name: string;
  entries: GlossaryEntry[];
}

/** 提供一键预设的服务商（均兼容 OpenAI）。 */
export type ProviderId = 'custom' | 'deepseek' | 'kimi';

export interface ProviderPreset {
  id: ProviderId;
  /** 人类可读的名称，保持英文以便在两种语言下读起来一致。 */
  name: string;
  baseUrl: string;
  model: string;
}

/** 国内服务商的一键预设（D 部分）。 */
export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  custom: { id: 'custom', name: 'Custom', baseUrl: '', model: '' },
  deepseek: { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  kimi: { id: 'kimi', name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
};

export const DEFAULT_HOTKEY = 'Ctrl+Shift+Z';

export interface AppSettings {
  /** 在主进程中加密存储。绝不暴露给渲染进程。 */
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  sourceLang: string;
  targetLang: string;
  activeGlossaryId: string | null;
  /** 界面语言：'en'（英文）或 'zh'（简体中文）。默认 zh。 */
  uiLanguage: 'en' | 'zh';
  /** 选中的服务商预设（驱动界面的下拉框，不影响请求）。 */
  provider: ProviderId;
  /** 用于剪贴板翻译的全局快捷键。 */
  hotkey: string;
  /** 离线翻译（transformers.js）总开关。 */
  offlineEnabled: boolean;
  /** 翻译应使用的引擎。默认 `auto`。 */
  translateEngine: TranslateEngine;
  /** 为历史记录 / EPUB 导出记录的最新章节标题。 */
  lastChapterTitle: string;
  /** 自动清理历史：应用启动时删除超过该天数的记录，0 表示关闭。 */
  historyAutoDeleteDays: number;
}

/** 渲染进程所见的设置——API 密钥被替换为一个布尔标志。 */
export type SettingsPublic = Omit<AppSettings, 'apiKey'> & {
  hasApiKey: boolean;
};

/** settings:set IPC 处理器接受的补丁对象。 */
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
  translateEngine?: TranslateEngine;
  lastChapterTitle?: string;
  historyAutoDeleteDays?: number;
}

export interface TranslateRequest {
  text: string;
  /** 已在渲染进程组装好的完整系统提示词（术语表 + 规则）。 */
  systemPrompt: string;
  /** 随历史记录一并写入的可选章节标题。 */
  chapterTitle?: string;
}

export interface TranslateResult {
  success: boolean;
  text?: string;
  error?: string;
}

/** 分块翻译任务的进度（主进程 → 渲染进程事件）。 */
export interface TranslateProgress {
  /** 目前已完成的分块数，含由缓存提供的分块。 */
  done: number;
  /** 本次任务被拆分成的总分块数。 */
  total: number;
}

/**
 * 翻译应使用的引擎。
 *  - `auto`    — 已配置 API 密钥时走在线，否则走离线；
 *                在线尝试失败时回落到离线。
 *  - `online`  — 仅使用 API。
 *  - `offline` — 仅使用本地模型。
 */
export type TranslateEngine = 'auto' | 'online' | 'offline';

export interface TestConnectionResult {
  success: boolean;
  message: string;
  latencyMs?: number;
}

// ---- 翻译历史（A2 部分）-----------------------------------------------------

export interface HistoryEntry {
  id: number;
  source_text: string;
  translated_text: string;
  source_lang: string;
  target_lang: string;
  glossary_id: string | null;
  /** Unix 纪元毫秒。 */
  timestamp: number;
  chapter_title: string | null;
}

export interface HistoryQuery {
  /** 对原文/译文或章节标题的可选全文检索。 */
  search?: string;
  /** 从 1 开始的页码。 */
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

// ---- 离线翻译（A4 部分）-----------------------------------------------------

export interface OfflineStatus {
  enabled: boolean;
  /** 约 870 MB 模型正在下载时为 true。 */
  downloading: boolean;
  downloaded: boolean;
  /** 0..1 的下载进度，未在下载时为 null。 */
  progress: number | null;
  /** 目前已下载的字节数（空闲时为 undefined）。 */
  loadedBytes?: number;
  /**
   * 「整个」模型的字节总数，而不只是仍待下载的部分。使用完整大小可让进度分母
   * 在多次尝试之间保持稳定。
   */
  totalBytes?: number;
  /** 人类可读的错误，健康时为 null。 */
  error: string | null;
  /**
   * 该构建是否随包携带离线翻译引擎。
   *
   * `@xenova/transformers` 及其原生 ONNX 后端是 devDependencies——发布安装包会
   * 排除它们以守住 80 MB 的体积预算，因此离线翻译在那里确实无法运行。界面绝不能
   * 引导用户去做一次它无法使用的约 870 MB 下载。
   */
  engineAvailable: boolean;
}

// ---- 自动更新（A1 部分）-----------------------------------------------------

export interface UpdateCheckResult {
  /** 是否有更新的版本可用。 */
  available: boolean;
  version?: string;
  /** 非致命错误消息（如网络故障 / 占位源）。 */
  error?: string;
}

// ---- EPUB 导出（A5 部分）----------------------------------------------------

export interface EpubChapter {
  title: string;
  original: string;
  translated: string;
}

export interface EpubRequest {
  chapters: EpubChapter[];
  defaultTitle: string;
}

// ---- 应用健康状态 -----------------------------------------------------------

/**
 * 主进程某个子系统的健康状况。
 *
 * 子系统会降级而不是崩溃（损坏的 SQLite 文件绝不能阻止应用启动），但静默降级
 * 会令人困惑——界面读取它，从而能明确说明，而不是永远显示空列表。
 */
export interface SubsystemHealth {
  ok: boolean;
  /** 失败原因，健康时为 null。 */
  error: string | null;
}

/** SQLite 历史数据库的健康状况，外加其位置供诊断使用。 */
export interface DatabaseHealth extends SubsystemHealth {
  path: string;
}

export interface SystemHealth {
  database: DatabaseHealth;
}
