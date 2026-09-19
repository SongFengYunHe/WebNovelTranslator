/**
 * Preload script - the only bridge between the sandboxed renderer and the
 * main process. Exposes a minimal, functions-only API via contextBridge.
 * The API key never crosses this boundary.
 */
import { contextBridge, ipcRenderer } from 'electron';
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
} from '../shared/types';

export interface ElectronApi {
  // Popup window control
  panelClose: () => Promise<boolean>;
  panelMinimize: () => Promise<boolean>;

  // Settings
  getSettings: () => Promise<SettingsPublic>;
  saveSettings: (patch: SaveSettingsPatch) => Promise<SettingsPublic>;
  testConnection: () => Promise<TestConnectionResult>;

  // Application health
  systemHealth: () => Promise<SystemHealth>;

  // Translation
  translate: (req: TranslateRequest) => Promise<TranslateResult>;

  // Glossary
  glossaryList: () => Promise<Glossary[]>;
  glossaryCreate: (name: string) => Promise<Glossary>;
  glossaryRename: (id: string, name: string) => Promise<Glossary[]>;
  glossaryDelete: (id: string) => Promise<Glossary[]>;
  glossaryUpdateEntries: (id: string, entries: GlossaryEntry[]) => Promise<Glossary[]>;
  glossarySetActive: (id: string | null) => Promise<SettingsPublic>;

  // History (Part A2)
  historyList: (query: HistoryQuery) => Promise<HistoryPage>;
  historyDelete: (id: number) => Promise<boolean>;
  historyClear: () => Promise<boolean>;
  /** 清除指定天数之前的历史记录（历史体积管理）。 */
  historyClearOlder: (days: number) => Promise<number>;
  historyExport: (kind: HistoryExport) => Promise<{ ok: boolean; filePath?: string; count?: number; error?: string }>;

  // Auto-update (Part A1)
  updateCheck: () => Promise<UpdateCheckResult>;
  updateOpenDownload: () => Promise<boolean>;
  updateCheckAndPrompt: () => Promise<UpdateCheckResult>;

  // Global hotkey (Part A3)
  hotkeySet: (accelerator: string) => Promise<{ ok: boolean; reason?: string }>;

  // Offline translation (Part A4)
  offlineStatus: () => Promise<OfflineStatus>;
  offlineDownload: () => Promise<OfflineStatus>;
  /** v3.0.1: runtime download of the offline model (fetch from Hugging Face). */
  downloadModel: () => Promise<OfflineStatus>;
  offlineDisable: () => Promise<OfflineStatus>;
  offlineTranslate: (req: TranslateRequest) => Promise<TranslateResult>;

  // EPUB export (Part A5)
  epubExport: (req: EpubRequest) => Promise<{ ok: boolean; filePath?: string; error?: string }>;

  // Main-process → renderer events
  onHotkeyResult: (cb: (payload: { original: string; translated: string }) => void) => () => void;
  onOfflineProgress: (cb: (status: OfflineStatus) => void) => () => void;
  onNotify: (cb: (payload: { title: string; body: string }) => void) => () => void;
}

const api: ElectronApi = {
  panelClose: () => ipcRenderer.invoke('panel:close'),
  panelMinimize: () => ipcRenderer.invoke('panel:minimize'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  testConnection: () => ipcRenderer.invoke('settings:test-connection'),

  systemHealth: () => ipcRenderer.invoke('system:health'),

  translate: (req) => ipcRenderer.invoke('translate', req),

  glossaryList: () => ipcRenderer.invoke('glossary:list'),
  glossaryCreate: (name) => ipcRenderer.invoke('glossary:create', name),
  glossaryRename: (id, name) => ipcRenderer.invoke('glossary:rename', id, name),
  glossaryDelete: (id) => ipcRenderer.invoke('glossary:delete', id),
  glossaryUpdateEntries: (id, entries) => ipcRenderer.invoke('glossary:update-entries', id, entries),
  glossarySetActive: (id) => ipcRenderer.invoke('glossary:set-active', id),

  historyList: (query) => ipcRenderer.invoke('history:list', query),
  historyDelete: (id) => ipcRenderer.invoke('history:delete', id),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  historyClearOlder: (days) => ipcRenderer.invoke('history:clear-older', days),
  historyExport: (kind) => ipcRenderer.invoke('history:export', kind),

  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateOpenDownload: () => ipcRenderer.invoke('update:open-download'),
  updateCheckAndPrompt: () => ipcRenderer.invoke('update:check-and-prompt'),

  hotkeySet: (accelerator) => ipcRenderer.invoke('hotkey:set', accelerator),

  offlineStatus: () => ipcRenderer.invoke('offline:status'),
  offlineDownload: () => ipcRenderer.invoke('offline:download'),
  downloadModel: () => ipcRenderer.invoke('download-model'),
  offlineDisable: () => ipcRenderer.invoke('offline:disable'),
  offlineTranslate: (req) => ipcRenderer.invoke('offline:translate', req),

  epubExport: (req) => ipcRenderer.invoke('epub:export', req),

  onHotkeyResult: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { original: string; translated: string }) =>
      cb(payload);
    ipcRenderer.on('hotkey:result', listener);
    return () => ipcRenderer.removeListener('hotkey:result', listener);
  },
  onOfflineProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, status: OfflineStatus) => cb(status);
    ipcRenderer.on('offline:progress', listener);
    return () => ipcRenderer.removeListener('offline:progress', listener);
  },
  onNotify: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { title: string; body: string }) =>
      cb(payload);
    ipcRenderer.on('app:notify', listener);
    return () => ipcRenderer.removeListener('app:notify', listener);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
