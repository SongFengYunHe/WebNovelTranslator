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
} from '../shared/types';
import { DEFAULT_HOTKEY } from '../shared/types';

/** Key derivation seed for electron-store's built-in AES-256-GCM encryption. */
const ENCRYPTION_KEY = 'web-novel-translator-v1-secret-key';

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  temperature: 0.7,
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
  offlineModelDownloaded: false,
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

export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...settingsStore.get('settings') };
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
  if (typeof patch.offlineModelDownloaded === 'boolean') {
    next.offlineModelDownloaded = patch.offlineModelDownloaded;
  }
  if (typeof patch.lastChapterTitle === 'string') next.lastChapterTitle = patch.lastChapterTitle;
  // 历史自动清理天数：>=0 才允许写入（0 表示关闭）。
  if (typeof patch.historyAutoDeleteDays === 'number' && patch.historyAutoDeleteDays >= 0) {
    next.historyAutoDeleteDays = Math.floor(patch.historyAutoDeleteDays);
  }
  // Never overwrite the stored key with an empty string. Only a non-empty
  // value replaces it.
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
    next.apiKey = patch.apiKey.trim();
  }
  settingsStore.set('settings', next);
  return toPublic(next);
}
