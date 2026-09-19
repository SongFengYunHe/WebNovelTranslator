/**
 * Encrypted settings store (electron-store) + defaults.
 *
 * The v1 on-disk format is preserved; v2 fields are additive and defaulted, so
 * an existing `settings.json` from 1.x upgrades seamlessly.
 *
 * 设置以 AES-256-GCM 加密存储在 userData，API 密钥绝不进入渲染进程。
 * 新增字段需同时更新 DEFAULT_SETTINGS、updateSettings 与 shared/types。
 */
import Store from 'electron-store';
import type {
  AppSettings,
  ProviderId,
  SaveSettingsPatch,
  SettingsPublic,
  TranslateEngine,
} from '../shared/types';
import { DEFAULT_HOTKEY } from '../shared/types';
import { readApiKey, writeApiKey } from './secret';
import log from './logger';

/**
 * electron-store's built-in AES-256-GCM seed.
 *
 * This is NOT a secret — it is committed to the repository, so it only
 * obfuscates `settings.json`; it does not protect anything from someone who has
 * the file. It is retained solely so the existing on-disk format keeps working.
 * The one genuinely sensitive field, the API key, is stored separately under
 * OS-level encryption (see `./secret.ts`).
 */
const ENCRYPTION_KEY = 'web-novel-translator-v1-secret-key';

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  // 0.3 rather than 0.7: translation wants fidelity, not creative variation.
  temperature: 0.3,
  maxTokens: 4096,
  sourceLang: 'zh',
  targetLang: 'en',
  activeGlossaryId: null,
  // Part E1: Simplified Chinese is the default UI language.
  uiLanguage: 'zh',
  // Part D: provider preset selector.
  provider: 'custom',
  // Part A3: configurable global hotkey.
  hotkey: DEFAULT_HOTKEY,
  // Part A4: offline translation.
  offlineEnabled: false,
  // Which engine to translate with; `auto` keeps the previous behaviour.
  translateEngine: 'auto',
  // Part A2/A5: last chapter title.
  lastChapterTitle: '',
  // 历史自动清理：默认删除超过 90 天的记录，0 表示关闭。
  historyAutoDeleteDays: 90,
};

const settingsStore = new Store<{ settings: AppSettings }>({
  name: 'settings',
  encryptionKey: ENCRYPTION_KEY,
  defaults: { settings: DEFAULT_SETTINGS },
});

/** Read settings.json and fold in defaults. */
function readStoredSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...settingsStore.get('settings') };
}

/**
 * One-shot migration: v3.0.1 and earlier persisted the API key inside
 * `settings.json`. Move it into OS-protected storage and blank the field so the
 * file no longer carries the key.
 *
 * Idempotent — the guard short-circuits on every run after the first, and a
 * failure keeps the legacy value in place rather than losing the key.
 */
function migrateLegacyApiKey(stored: AppSettings): AppSettings {
  if (!stored.apiKey) return stored;
  try {
    writeApiKey(stored.apiKey);
    const next: AppSettings = { ...stored, apiKey: '' };
    settingsStore.set('settings', next);
    log.info('[settings] migrated the API key out of settings.json into OS-protected storage');
    return next;
  } catch (err) {
    log.error('[settings] API key migration failed — keeping the legacy value:', err);
    return stored;
  }
}

export function getSettings(): AppSettings {
  const stored = migrateLegacyApiKey(readStoredSettings());
  // The secret store is authoritative once it holds a key. If it is empty while
  // the legacy field still has a value, migration must have failed — keep using
  // the legacy key rather than dropping it.
  const secret = readApiKey();
  return { ...stored, apiKey: secret || stored.apiKey };
}

export function toPublic(s: AppSettings): SettingsPublic {
  const { apiKey, ...rest } = s;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

const isProvider = (v: unknown): v is ProviderId =>
  v === 'custom' || v === 'deepseek' || v === 'kimi';

const isTranslateEngine = (v: unknown): v is TranslateEngine =>
  v === 'auto' || v === 'online' || v === 'offline';

/**
 * Apply a partial patch and persist. Backward compatible: only known fields are
 * written, and the API key is only ever replaced by a non-empty string.
 */
export function updateSettings(patch: SaveSettingsPatch): SettingsPublic {
  const cur = getSettings();
  const next: AppSettings = { ...cur };
  if (typeof patch.baseUrl === 'string') next.baseUrl = patch.baseUrl;
  if (typeof patch.model === 'string') next.model = patch.model;
  if (typeof patch.temperature === 'number') next.temperature = patch.temperature;
  if (typeof patch.maxTokens === 'number') next.maxTokens = patch.maxTokens;
  if (typeof patch.sourceLang === 'string') next.sourceLang = patch.sourceLang;
  if (typeof patch.targetLang === 'string') next.targetLang = patch.targetLang;
  if (patch.activeGlossaryId === null || typeof patch.activeGlossaryId === 'string') {
    next.activeGlossaryId = patch.activeGlossaryId;
  }
  if (patch.uiLanguage === 'en' || patch.uiLanguage === 'zh') {
    next.uiLanguage = patch.uiLanguage;
  }
  if (isProvider(patch.provider)) next.provider = patch.provider;
  if (typeof patch.hotkey === 'string' && patch.hotkey.trim()) next.hotkey = patch.hotkey.trim();
  if (typeof patch.offlineEnabled === 'boolean') next.offlineEnabled = patch.offlineEnabled;
  if (isTranslateEngine(patch.translateEngine)) next.translateEngine = patch.translateEngine;
  if (typeof patch.lastChapterTitle === 'string') next.lastChapterTitle = patch.lastChapterTitle;
  // 历史自动清理天数：>=0 才允许写入（0 表示关闭）。
  if (typeof patch.historyAutoDeleteDays === 'number' && patch.historyAutoDeleteDays >= 0) {
    next.historyAutoDeleteDays = Math.floor(patch.historyAutoDeleteDays);
  }
  // The key itself goes to OS-protected storage. Only a non-empty value
  // replaces the existing key, so leaving the field blank keeps it. A genuine
  // write failure throws, letting the renderer tell the user it was not saved.
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
    writeApiKey(patch.apiKey);
  }

  // settings.json must never carry the key — but blank the legacy field only
  // once the secret store is known to hold it, so a failed migration cannot
  // lose a key the user already had.
  const secret = readApiKey();
  settingsStore.set('settings', { ...next, apiKey: secret ? '' : next.apiKey });

  return toPublic({ ...next, apiKey: secret || next.apiKey });
}
