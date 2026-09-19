/**
 * 渲染进程侧围绕 window.electronAPI 的轻量封装。所有繁重工作（文件 IO、网络调用、
 * 密钥处理、SQLite）都在主进程中进行。
 */
import type {
  EpubRequest,
  Glossary,
  GlossaryEntry,
  HistoryExport,
  HistoryPage,
  HistoryQuery,
  OfflineStatus,
  SaveSettingsPatch,
  SettingsPublic,
  SystemHealth,
  TestConnectionResult,
  TranslateRequest,
  TranslateResult,
  UpdateCheckResult,
} from '../../shared/types';

export function apiTranslate(req: TranslateRequest): Promise<TranslateResult> {
  return window.electronAPI.translate(req);
}

/** 取消进行中的分块翻译任务。 */
export function apiCancelTranslate(): Promise<boolean> {
  return window.electronAPI.cancelTranslate();
}

export function apiTestConnection(): Promise<TestConnectionResult> {
  return window.electronAPI.testConnection();
}

export function apiGetSettings(): Promise<SettingsPublic> {
  return window.electronAPI.getSettings();
}

/** 主进程子系统健康状况（目前是 SQLite 历史数据库）。 */
export function apiSystemHealth(): Promise<SystemHealth> {
  return window.electronAPI.systemHealth();
}

export function apiSaveSettings(patch: SaveSettingsPatch): Promise<SettingsPublic> {
  return window.electronAPI.saveSettings(patch);
}

export function apiGlossaryList(): Promise<Glossary[]> {
  return window.electronAPI.glossaryList();
}

export function apiGlossaryCreate(name: string): Promise<Glossary> {
  return window.electronAPI.glossaryCreate(name);
}

export function apiGlossaryRename(id: string, name: string): Promise<Glossary[]> {
  return window.electronAPI.glossaryRename(id, name);
}

export function apiGlossaryDelete(id: string): Promise<Glossary[]> {
  return window.electronAPI.glossaryDelete(id);
}

export function apiGlossaryUpdateEntries(id: string, entries: GlossaryEntry[]): Promise<Glossary[]> {
  return window.electronAPI.glossaryUpdateEntries(id, entries);
}

export function apiGlossarySetActive(id: string | null): Promise<SettingsPublic> {
  return window.electronAPI.glossarySetActive(id);
}

export function apiHistoryList(query: HistoryQuery): Promise<HistoryPage> {
  return window.electronAPI.historyList(query);
}

export function apiHistoryDelete(id: number): Promise<boolean> {
  return window.electronAPI.historyDelete(id);
}

export function apiHistoryClear(): Promise<boolean> {
  return window.electronAPI.historyClear();
}

/** 清除指定天数之前的历史记录（历史体积管理）。 */
export function apiHistoryClearOlder(days: number): Promise<number> {
  return window.electronAPI.historyClearOlder(days);
}

export function apiHistoryExport(kind: HistoryExport): Promise<{ ok: boolean; filePath?: string; count?: number; error?: string }> {
  return window.electronAPI.historyExport(kind);
}

export function apiUpdateCheck(): Promise<UpdateCheckResult> {
  return window.electronAPI.updateCheck();
}

export function apiUpdateOpenDownload(): Promise<boolean> {
  return window.electronAPI.updateOpenDownload();
}

export function apiHotkeySet(accelerator: string): Promise<{ ok: boolean; reason?: string }> {
  return window.electronAPI.hotkeySet(accelerator);
}

export function apiOfflineStatus(): Promise<OfflineStatus> {
  return window.electronAPI.offlineStatus();
}

/** v3.0.1：启动运行时模型下载（主进程 fetch → 缓存）。 */
export function apiOfflineDownload(): Promise<OfflineStatus> {
  return window.electronAPI.downloadModel();
}

export function apiOfflineDisable(): Promise<OfflineStatus> {
  return window.electronAPI.offlineDisable();
}

export function apiOfflineTranslate(req: TranslateRequest): Promise<TranslateResult> {
  return window.electronAPI.offlineTranslate(req);
}

export function apiEpubExport(req: EpubRequest): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  return window.electronAPI.epubExport(req);
}
