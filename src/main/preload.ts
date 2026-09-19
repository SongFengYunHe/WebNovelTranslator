/**
 * 预加载脚本——沙箱化渲染进程与主进程之间唯一的桥梁。通过 contextBridge 暴露
 * 一套最小化、仅含函数的 API。API 密钥绝不跨越此边界。
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
  TranslateProgress,
  TranslateResult,
  UpdateCheckResult,
} from '../shared/types';

export interface ElectronApi {
  // 弹窗窗口控制
  panelClose: () => Promise<boolean>;
  panelMinimize: () => Promise<boolean>;

  // 设置
  getSettings: () => Promise<SettingsPublic>;
  saveSettings: (patch: SaveSettingsPatch) => Promise<SettingsPublic>;
  testConnection: () => Promise<TestConnectionResult>;

  // 应用健康状态
  systemHealth: () => Promise<SystemHealth>;

  // 翻译
  translate: (req: TranslateRequest) => Promise<TranslateResult>;
  /** 取消进行中的分块翻译任务。 */
  cancelTranslate: () => Promise<boolean>;

  // 术语表
  glossaryList: () => Promise<Glossary[]>;
  glossaryCreate: (name: string) => Promise<Glossary>;
  glossaryRename: (id: string, name: string) => Promise<Glossary[]>;
  glossaryDelete: (id: string) => Promise<Glossary[]>;
  glossaryUpdateEntries: (id: string, entries: GlossaryEntry[]) => Promise<Glossary[]>;
  glossarySetActive: (id: string | null) => Promise<SettingsPublic>;

  // 历史记录（A2 部分）
  historyList: (query: HistoryQuery) => Promise<HistoryPage>;
  historyDelete: (id: number) => Promise<boolean>;
  historyClear: () => Promise<boolean>;
  /** 清除指定天数之前的历史记录（历史体积管理）。 */
  historyClearOlder: (days: number) => Promise<number>;
  historyExport: (kind: HistoryExport) => Promise<{ ok: boolean; filePath?: string; count?: number; error?: string }>;

  // 自动更新（A1 部分）
  updateCheck: () => Promise<UpdateCheckResult>;
  updateOpenDownload: () => Promise<boolean>;

  // 全局快捷键（A3 部分）
  hotkeySet: (accelerator: string) => Promise<{ ok: boolean; reason?: string }>;

  // 离线翻译（A4 部分）
  offlineStatus: () => Promise<OfflineStatus>;
  /** v3.0.1：运行时下载离线模型（从 Hugging Face 拉取）。 */
  downloadModel: () => Promise<OfflineStatus>;
  offlineDisable: () => Promise<OfflineStatus>;
  offlineTranslate: (req: TranslateRequest) => Promise<TranslateResult>;

  // EPUB 导出（A5 部分）
  epubExport: (req: EpubRequest) => Promise<{ ok: boolean; filePath?: string; error?: string }>;

  // 主进程 → 渲染进程事件
  onHotkeyResult: (cb: (payload: { original: string; translated: string }) => void) => () => void;
  onOfflineProgress: (cb: (status: OfflineStatus) => void) => () => void;
  onNotify: (cb: (payload: { title: string; body: string }) => void) => () => void;
  /** 长耗时、分块翻译任务的分块进度。 */
  onTranslateProgress: (cb: (progress: TranslateProgress) => void) => () => void;
}

const api: ElectronApi = {
  panelClose: () => ipcRenderer.invoke('panel:close'),
  panelMinimize: () => ipcRenderer.invoke('panel:minimize'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  testConnection: () => ipcRenderer.invoke('settings:test-connection'),

  systemHealth: () => ipcRenderer.invoke('system:health'),

  translate: (req) => ipcRenderer.invoke('translate', req),
  cancelTranslate: () => ipcRenderer.invoke('translate:cancel'),

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

  hotkeySet: (accelerator) => ipcRenderer.invoke('hotkey:set', accelerator),

  offlineStatus: () => ipcRenderer.invoke('offline:status'),
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
  onTranslateProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, progress: TranslateProgress) => cb(progress);
    ipcRenderer.on('translate:progress', listener);
    return () => ipcRenderer.removeListener('translate:progress', listener);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
