/**
 * 窗口状态持久化（E6 部分）：通过 electron-store 保存并恢复主面板的位置与尺寸，
 * 让应用在用户上次离开的地方重新打开。
 *
 * 值在应用到 BrowserWindow 之前会先校验，因此陈旧或损坏的存储条目绝不会创建出
 * 屏幕外的窗口。
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

/** 当 `bounds` 与当前连接的某个显示器相交时为 true。 */
function isVisibleOnSomeDisplay(bounds: Bounds): boolean {
  const w = Math.max(bounds.width, 0);
  const h = Math.max(bounds.height, 0);
  const rect: Rectangle = { x: bounds.x, y: bounds.y, width: w, height: h };
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const overlapW = Math.max(0, Math.min(a.x + a.width, bounds.x + w) - Math.max(a.x, bounds.x));
    const overlapH = Math.max(0, Math.min(a.y + a.height, bounds.y + h) - Math.max(a.y, bounds.y));
    // 要求有实质重叠（≥ 100x100 px），这样滑出已拔掉显示器的窗口会被重新居中，
    // 而不是恢复到不可见的位置。
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
