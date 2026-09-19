/**
 * 加密设置存储（electron-store）+ 默认值。
 *
 * v1 的磁盘格式予以保留；v2 的字段是新增且带默认值的，因此 1.x 的现有
 * `settings.json` 可无缝升级。
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
 * electron-store 内置的 AES-256-GCM 种子。
 *
 * 这「不是」机密——它已提交到仓库，因此只能混淆 `settings.json`，无法对拿到该
 * 文件的人提供任何保护。保留它仅仅是为了让现有磁盘格式继续可用。唯一真正敏感
 * 的字段——API 密钥——以操作系统级加密单独存储（见 `./secret.ts`）。
 */
const ENCRYPTION_KEY = 'web-novel-translator-v1-secret-key';

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  // 用 0.3 而非 0.7：翻译追求忠实，而非创造性变化。
  temperature: 0.3,
  maxTokens: 4096,
  sourceLang: 'zh',
  targetLang: 'en',
  activeGlossaryId: null,
  // E1 部分：默认界面语言为简体中文。
  uiLanguage: 'zh',
  // D 部分：服务商预设选择器。
  provider: 'custom',
  // A3 部分：可配置的全局快捷键。
  hotkey: DEFAULT_HOTKEY,
  // A4 部分：离线翻译。
  offlineEnabled: false,
  // 使用哪种引擎翻译；`auto` 保持原有行为。
  translateEngine: 'auto',
  // A2/A5 部分：上一章的章节标题。
  lastChapterTitle: '',
  // 历史自动清理：默认删除超过 90 天的记录，0 表示关闭。
  historyAutoDeleteDays: 90,
};

const settingsStore = new Store<{ settings: AppSettings }>({
  name: 'settings',
  encryptionKey: ENCRYPTION_KEY,
  defaults: { settings: DEFAULT_SETTINGS },
});

/** 读取 settings.json 并合入默认值。 */
function readStoredSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...settingsStore.get('settings') };
}

/**
 * 一次性迁移：v3.0.1 及更早版本把 API 密钥持久化在 `settings.json` 内。将其移入
 * 操作系统保护的存储，并清空该字段，使文件不再携带密钥。
 *
 * 幂等——首次之后每次运行都会被守卫短路，且失败时保留旧值而不是丢失密钥。
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
  // 一旦密钥存储持有密钥，它就是权威来源。若其为空而旧字段仍有值，说明迁移
  // 一定失败了——继续使用旧密钥而不是丢弃它。
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
 * 应用部分补丁并持久化。向后兼容：只写入已知字段，且 API 密钥只会被非空字符串
 * 替换。
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
  // 密钥本身进入操作系统保护的存储。只有非空值才会替换现有密钥，因此留空
  // 即保留原密钥。真正的写入失败会抛异常，让渲染进程告知用户未保存。
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
    writeApiKey(patch.apiKey);
  }

  // settings.json 绝不能携带密钥——但只有在确认密钥存储已持有它之后才清空
  // 旧字段，这样迁移失败也不会丢掉用户原有的密钥。
  const secret = readApiKey();
  settingsStore.set('settings', { ...next, apiKey: secret ? '' : next.apiKey });

  return toPublic({ ...next, apiKey: secret || next.apiKey });
}
