/**
 * Ambient type declarations for the renderer.
 *
 *  - `window.electronAPI` is typed by the `ElectronApi` interface exported from
 *    the preload script itself, so the bridge has exactly ONE definition and
 *    cannot drift from the implementation.
 *  - The `<webview>` custom element used by BrowserView.
 */
import type { ElectronApi } from '../main/preload';

declare global {
  interface Window {
    electronAPI: ElectronApi;
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