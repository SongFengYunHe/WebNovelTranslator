/**
 * 语义化版本比较。
 *
 * 放在 `shared/` 中（无依赖、不引入 Electron），因此可直接单元测试——
 * `src/main/services/update.ts` 过去把这套逻辑放在 `electron-updater` 导入旁边，
 * 导致没有 Electron 运行时就无法测试。
 */

/**
 * 比较两个以点分隔的版本字符串。
 *
 * @returns `a` 比 `b` 新时返回正数，更旧时返回负数，相等时返回 `0`。缺失或非数字
 *          的段按 `0` 处理，因此 `"1.2"` 与 `"1.2.0"` 比较结果相等。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** `candidate` 严格新于 `current` 时为 true。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}