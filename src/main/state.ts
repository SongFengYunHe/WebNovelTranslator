/**
 * Window state persistence (Part E6): save & restore the main panel's bounds
 * via electron-store, so the app reopens where the user left it.
 *
 * Values are validated before being applied to a BrowserWindow, so a stale or
 * corrupted store entry can never create an off-screen window.
 *
 * 窗口状态恢复守卫：保存的坐标若已不在当前显示器工作区内（例如显示器被拔掉），
 * 则返回 undefined，主进程会回退到默认居中位置，避免窗口在屏幕外无法找回。
 */
import Store from 'electron-store';
import { screen } from 'electron';
import type { Rectangle } from 'electron';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowStateStore {
  mainBounds?: Bounds;
}

const store = new Store<WindowStateStore>({
  name: 'window-state',
  defaults: {},
});

/** True when `bounds` intersects a currently connected display. */
function isVisibleOnSomeDisplay(bounds: Bounds): boolean {
  const w = Math.max(bounds.width, 0);
  const h = Math.max(bounds.height, 0);
  const rect: Rectangle = { x: bounds.x, y: bounds.y, width: w, height: h };
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const overlapW = Math.max(0, Math.min(a.x + a.width, bounds.x + w) - Math.max(a.x, bounds.x));
    const overlapH = Math.max(0, Math.min(a.y + a.height, bounds.y + h) - Math.max(a.y, bounds.y));
    // Require a meaningful overlap (≥ 100x100 px) so a window that slid off a
    // monitor that was unplugged gets re-centered instead of restored invisible.
    return overlapW >= 100 && overlapH >= 100;
  });
}

export function getMainWindowBounds(): Bounds | undefined {
  const b = store.get('mainBounds');
  if (b && b.width >= 680 && b.height >= 520 && isVisibleOnSomeDisplay(b)) {
    return b;
  }
  return undefined;
}

export function saveMainWindowBounds(bounds: Bounds): void {
  if (bounds.width > 0 && bounds.height > 0) {
    store.set('mainBounds', bounds);
  }
}
