/**
 * 已完成翻译的内存 LRU 缓存。
 *
 * 重新翻译同一章节——或重跑同一次全局划词——很常见且完全可避免的 API 开销。
 * 条目仅在进程生命周期内存在：持久化缓存需要自己的 schema 以及失效规则，收益
 * 相对较小。
 *
 * 未引入 Electron，因此淘汰逻辑可做单元测试。
 */
import { createHash } from 'crypto';

/** 保持内存有界；每个条目存放完整的译文。 */
export const MAX_CACHE_ENTRIES = 50;

/** 按插入顺序排列，因此第一个键始终是最久未使用的。 */
const store = new Map<string, string>();

/**
 * 单个翻译单元的稳定缓存键。
 *
 * 采用哈希而非直接存储原文，因为文本可能达数百 KB；直接用作键会让缓存占用的
 * 内存翻倍。模型与端点也计入键中，因此切换服务商不会返回由另一服务商产出的译文。
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

/** 查询缓存的译文，命中时刷新其新近度。 */
export function getCachedTranslation(key: string): string | undefined {
  const hit = store.get(key);
  if (hit === undefined) return undefined;
  // 重新插入，使该键成为最近使用的。
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