/**
 * In-memory LRU cache for completed translations.
 *
 * Re-translating the same chapter — or re-running the same global-hotkey
 * selection — is a common and entirely avoidable API cost. Entries live for the
 * process lifetime only: a persistent cache would need its own schema plus
 * invalidation rules for a comparatively small win.
 *
 * No Electron imports, so the eviction logic is unit testable.
 */
import { createHash } from 'crypto';

/** Keeps memory bounded; each entry holds the full translated text. */
export const MAX_CACHE_ENTRIES = 50;

/** Insertion-ordered, so the first key is always the least recently used. */
const store = new Map<string, string>();

/**
 * Stable cache key for one translation unit.
 *
 * Hashed rather than stored raw because the text can be hundreds of kilobytes;
 * using it directly as a key would double the memory the cache holds. The model
 * and endpoint are part of the key so switching providers cannot return a
 * translation produced by a different one.
 */
export function translationCacheKey(parts: {
  text: string;
  systemPrompt: string;
  model: string;
  baseUrl: string;
}): string {
  const hash = createHash('sha256');
  for (const part of [parts.text, parts.systemPrompt, parts.model, parts.baseUrl]) {
    hash.update(part);
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

/** Look up a cached translation, refreshing its recency on a hit. */
export function getCachedTranslation(key: string): string | undefined {
  const hit = store.get(key);
  if (hit === undefined) return undefined;
  // Re-insert so this key becomes the most recently used.
  store.delete(key);
  store.set(key, hit);
  return hit;
}

export function cacheTranslation(key: string, value: string): void {
  store.delete(key);
  store.set(key, value);
  while (store.size > MAX_CACHE_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function clearTranslationCache(): void {
  store.clear();
}

export function translationCacheSize(): number {
  return store.size;
}