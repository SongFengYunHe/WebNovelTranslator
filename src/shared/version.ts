/**
 * Semantic-version comparison.
 *
 * Kept in `shared/` (dependency-free, no Electron imports) so it can be unit
 * tested directly — `src/main/services/update.ts` previously held this logic
 * next to an `electron-updater` import, which made it untestable without an
 * Electron runtime.
 */

/**
 * Compare two dot-separated version strings.
 *
 * @returns a positive number when `a` is newer than `b`, negative when older,
 *          and `0` when they are equivalent. Missing or non-numeric segments
 *          are treated as `0`, so `"1.2"` and `"1.2.0"` compare equal.
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

/** True when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}