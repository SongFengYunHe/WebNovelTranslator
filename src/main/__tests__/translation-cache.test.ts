import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CACHE_ENTRIES,
  cacheTranslation,
  clearTranslationCache,
  getCachedTranslation,
  translationCacheKey,
  translationCacheSize,
} from '../translation-cache';

const base = { text: '原文', systemPrompt: 'sys', model: 'gpt-4o', baseUrl: 'https://api.x/v1' };

describe('translationCacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(translationCacheKey(base)).toBe(translationCacheKey({ ...base }));
  });

  it('changes when any component changes', () => {
    const original = translationCacheKey(base);
    expect(translationCacheKey({ ...base, text: '别的原文' })).not.toBe(original);
    expect(translationCacheKey({ ...base, systemPrompt: 'other' })).not.toBe(original);
    expect(translationCacheKey({ ...base, model: 'deepseek-chat' })).not.toBe(original);
    expect(translationCacheKey({ ...base, baseUrl: 'https://api.y/v1' })).not.toBe(original);
  });

  it('does not collide across field boundaries', () => {
    // Without a separator, {text:'ab', model:'c'} and {text:'a', model:'bc'}
    // would hash identically.
    const a = translationCacheKey({ ...base, text: 'ab', model: 'c' });
    const b = translationCacheKey({ ...base, text: 'a', model: 'bc' });
    expect(a).not.toBe(b);
  });

  it('returns a fixed-width hex digest rather than the raw text', () => {
    const key = translationCacheKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('原文');
  });
});

describe('translation cache', () => {
  beforeEach(() => clearTranslationCache());

  it('misses on an unknown key', () => {
    expect(getCachedTranslation('nope')).toBeUndefined();
  });

  it('round-trips a stored translation', () => {
    cacheTranslation('k', 'translated');
    expect(getCachedTranslation('k')).toBe('translated');
  });

  it('overwrites an existing key', () => {
    cacheTranslation('k', 'first');
    cacheTranslation('k', 'second');
    expect(getCachedTranslation('k')).toBe('second');
    expect(translationCacheSize()).toBe(1);
  });

  it('evicts the least recently used entry once full', () => {
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) cacheTranslation(`k${i}`, `v${i}`);
    expect(translationCacheSize()).toBe(MAX_CACHE_ENTRIES);

    cacheTranslation('overflow', 'v');
    expect(translationCacheSize()).toBe(MAX_CACHE_ENTRIES);
    expect(getCachedTranslation('k0')).toBeUndefined();
    expect(getCachedTranslation('overflow')).toBe('v');
  });

  it('refreshes recency on a hit, so a read protects an entry from eviction', () => {
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) cacheTranslation(`k${i}`, `v${i}`);
    // Touch the oldest entry, then overflow the cache.
    expect(getCachedTranslation('k0')).toBe('v0');
    cacheTranslation('overflow', 'v');

    expect(getCachedTranslation('k0')).toBe('v0');
    // k1 is now the least recently used.
    expect(getCachedTranslation('k1')).toBeUndefined();
  });

  it('empties the cache on clear', () => {
    cacheTranslation('k', 'v');
    clearTranslationCache();
    expect(translationCacheSize()).toBe(0);
    expect(getCachedTranslation('k')).toBeUndefined();
  });
});