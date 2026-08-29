/**
 * Ambient type declarations for the renderer.
 *  - `window.electronAPI` typed API exposed by the preload script.
 *  - The `<webview>` custom element used by BrowserView.
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
  TestConnectionResult,
  TranslateRequest,
  TranslateResult,
  UpdateCheckResult,
} from '../shared/types';

declare global {
  interface Window {
    electronAPI: {
      panelClose: () => Promise<boolean>;
      panelMinimize: () => Promise<boolean>;

      getSettings: () => Promise<SettingsPublic>;
      saveSettings: (patch: SaveSettingsPatch) => Promise<SettingsPublic>;
      testConnection: () => Promise<TestConnectionResult>;

      translate: (req: TranslateRequest) => Promise<TranslateResult>;

      glossaryList: () => Promise<Glossary[]>;
      glossaryCreate: (name: string) => Promise<Glossary>;
      glossaryRename: (id: string, name: string) => Promise<Glossary[]>;
      glossaryDelete: (id: string) => Promise<Glossary[]>;
      glossaryUpdateEntries: (id: string, entries: GlossaryEntry[]) => Promise<Glossary[]>;
      glossarySetActive: (id: string | null) => Promise<SettingsPublic>;

      historyList: (query: HistoryQuery) => Promise<HistoryPage>;
      historyDelete: (id: number) => Promise<boolean>;
      historyClear: () => Promise<boolean>;
      historyClearOlder: (days: number) => Promise<number>;
      historyExport: (kind: HistoryExport) => Promise<{ ok: boolean; filePath?: string; count?: number; error?: string }>;

      updateCheck: () => Promise<UpdateCheckResult>;
      updateOpenDownload: () => Promise<boolean>;
      updateCheckAndPrompt: () => Promise<UpdateCheckResult>;

      hotkeySet: (accelerator: string) => Promise<{ ok: boolean; reason?: string }>;

      offlineStatus: () => Promise<OfflineStatus>;
      offlineDownload: () => Promise<OfflineStatus>;
      downloadModel: () => Promise<OfflineStatus>;
      offlineDisable: () => Promise<OfflineStatus>;
      offlineTranslate: (req: TranslateRequest) => Promise<TranslateResult>;

      epubExport: (req: EpubRequest) => Promise<{ ok: boolean; filePath?: string; error?: string }>;

      onHotkeyResult: (cb: (payload: { original: string; translated: string }) => void) => () => void;
      onOfflineProgress: (cb: (status: OfflineStatus) => void) => () => void;
      onNotify: (cb: (payload: { title: string; body: string }) => void) => () => void;
    };
  }

  /**
   * Electron <webview> element methods, merged with the `HTMLWebViewElement`
   * interface declared by @types/react. The standard DOM types don't include
   * the Electron-specific API surface.
   */
  interface HTMLWebViewElement extends HTMLElement {
    loadURL: (url: string, options?: Record<string, unknown>) => Promise<void>;
    getTitle: () => string;
    executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  }
}

export {};
