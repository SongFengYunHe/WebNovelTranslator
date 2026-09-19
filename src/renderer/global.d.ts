/**
 * 渲染进程的环境类型声明。
 *
 *  - `window.electronAPI` 由预加载脚本自身导出的 `ElectronApi` 接口定型，因此桥接
 *    只有「一份」定义，不会与实现漂移。
 *  - BrowserView 使用的 `<webview>` 自定义元素。
 */
import type { ElectronApi } from '../main/preload';

declare global {
  interface Window {
    electronAPI: ElectronApi;
  }

  /**
   * Electron <webview> 元素的方法，与 @types/react 声明的 `HTMLWebViewElement`
   * 接口合并。标准 DOM 类型不包含 Electron 特有的 API 表面。
   */
  interface HTMLWebViewElement extends HTMLElement {
    loadURL: (url: string, options?: Record<string, unknown>) => Promise<void>;
    getTitle: () => string;
    executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  }
}

export {};