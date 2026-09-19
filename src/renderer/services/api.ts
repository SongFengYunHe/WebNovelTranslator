/**
 * Thin renderer-side wrappers around window.electronAPI. All heavy lifting
 * (file IO, network calls, key handling, SQLite) happens in the main process.
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

export function apiTestConnection(): Promise<TestConnectionResult> {
  return window.electronAPI.testConnection();
}

export function apiGetSettings(): Promise<SettingsPublic> {
  return window.electronAPI.getSettings();
}

/** Main-process subsystem health (currently the SQLite history database). */
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

/** v3.0.1: kicks off the runtime model download (main-process fetch → cache). */
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
