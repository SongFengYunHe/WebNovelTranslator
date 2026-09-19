/**
 * Runtime validation for IPC payloads.
 *
 * The renderer is sandboxed, but it still runs third-party page content inside
 * the Browser tab's `<webview>`. If that content ever reaches
 * `window.electronAPI`, these checks are the boundary that stops malformed or
 * hostile arguments from reaching the filesystem, the SQLite database or the
 * encrypted settings store.
 *
 * Hand-rolled rather than schema-library-based on purpose: the surface is a
 * dozen primitives, and the installer has a hard size budget — a general
 * validation library would add several megabytes for no extra safety here.
 */
import type {
  EpubRequest,
  GlossaryEntry,
  HistoryExport,
  HistoryQuery,
  SaveSettingsPatch,
  TranslateRequest,
} from '../shared/types';

/** Raised when a payload fails validation. Callers log it and reject the IPC call. */
export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

// ---- Primitives -------------------------------------------------------------

/** Upper bounds are deliberately generous: they stop abuse, not real usage. */
const LIMITS = {
  text: 500_000,
  systemPrompt: 200_000,
  url: 500,
  model: 200,
  apiKey: 400,
  title: 500,
  name: 200,
  id: 64,
  search: 500,
  hotkey: 100,
  glossaryEntries: 10_000,
  glossaryTerm: 500,
  epubChapters: 2_000,
  epubBody: 2_000_000,
} as const;

function fail(message: string): never {
  throw new IpcValidationError(message);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, max: number, min = 0): string {
  if (typeof value !== 'string') fail(`${field} 必须是字符串`);
  if (value.length < min || value.length > max) {
    fail(`${field} 长度必须在 ${min}..${max} 之间（实际 ${value.length}）`);
  }
  return value;
}

function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(`${field} 必须是整数`);
  if (value < min || value > max) fail(`${field} 必须在 ${min}..${max} 之间（实际 ${value}）`);
  return value;
}

function requireFiniteNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field} 必须是数字`);
  if (value < min || value > max) fail(`${field} 必须在 ${min}..${max} 之间（实际 ${value}）`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(`${field} 必须是布尔值`);
  return value;
}

function requireOneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${field} 必须是 ${allowed.join(' / ')} 之一`);
  }
  return value as T;
}

/** `undefined` stays `undefined`; anything else must satisfy `check`. */
function optional<T>(value: unknown, field: string, check: (v: unknown) => T): T | undefined {
  return value === undefined ? undefined : check(value);
}

/** `null` stays `null`; anything else must satisfy `check`. */
function nullable<T>(value: unknown, field: string, check: (v: unknown) => T): T | null {
  return value === null ? null : check(value);
}

// ---- Payload validators -----------------------------------------------------

const providers = ['custom', 'deepseek', 'kimi'] as const;
const uiLanguages = ['en', 'zh'] as const;
const translateEngines = ['auto', 'online', 'offline'] as const;

/**
 * Validate a settings patch. Unknown keys are ignored (the store only reads the
 * fields it knows), and every recognised field is range-checked so a hostile
 * renderer cannot persist nonsense that later breaks the request path.
 */
export function validateSaveSettingsPatch(raw: unknown): SaveSettingsPatch {
  const o = asRecord(raw, 'settings patch');
  const patch: SaveSettingsPatch = {};

  const apiKey = optional(o.apiKey, 'apiKey', (v) => requireString(v, 'apiKey', LIMITS.apiKey));
  if (apiKey !== undefined) patch.apiKey = apiKey;

  const baseUrl = optional(o.baseUrl, 'baseUrl', (v) => requireString(v, 'baseUrl', LIMITS.url));
  if (baseUrl !== undefined) patch.baseUrl = baseUrl;

  const model = optional(o.model, 'model', (v) => requireString(v, 'model', LIMITS.model));
  if (model !== undefined) patch.model = model;

  const temperature = optional(o.temperature, 'temperature', (v) =>
    requireFiniteNumber(v, 'temperature', 0, 2)
  );
  if (temperature !== undefined) patch.temperature = temperature;

  const maxTokens = optional(o.maxTokens, 'maxTokens', (v) =>
    requireInt(v, 'maxTokens', 1, 1_000_000)
  );
  if (maxTokens !== undefined) patch.maxTokens = maxTokens;

  const sourceLang = optional(o.sourceLang, 'sourceLang', (v) =>
    requireString(v, 'sourceLang', LIMITS.id, 1)
  );
  if (sourceLang !== undefined) patch.sourceLang = sourceLang;

  const targetLang = optional(o.targetLang, 'targetLang', (v) =>
    requireString(v, 'targetLang', LIMITS.id, 1)
  );
  if (targetLang !== undefined) patch.targetLang = targetLang;

  const activeGlossaryId = optional(o.activeGlossaryId, 'activeGlossaryId', (v) =>
    nullable(v, 'activeGlossaryId', (x) => requireString(x, 'activeGlossaryId', LIMITS.id, 1))
  );
  if (activeGlossaryId !== undefined) patch.activeGlossaryId = activeGlossaryId;

  const uiLanguage = optional(o.uiLanguage, 'uiLanguage', (v) =>
    requireOneOf(v, 'uiLanguage', uiLanguages)
  );
  if (uiLanguage !== undefined) patch.uiLanguage = uiLanguage;

  const provider = optional(o.provider, 'provider', (v) => requireOneOf(v, 'provider', providers));
  if (provider !== undefined) patch.provider = provider;

  const hotkey = optional(o.hotkey, 'hotkey', (v) =>
    requireString(v, 'hotkey', LIMITS.hotkey, 1)
  );
  if (hotkey !== undefined) patch.hotkey = hotkey;

  const offlineEnabled = optional(o.offlineEnabled, 'offlineEnabled', (v) =>
    requireBoolean(v, 'offlineEnabled')
  );
  if (offlineEnabled !== undefined) patch.offlineEnabled = offlineEnabled;

  const translateEngine = optional(o.translateEngine, 'translateEngine', (v) =>
    requireOneOf(v, 'translateEngine', translateEngines)
  );
  if (translateEngine !== undefined) patch.translateEngine = translateEngine;

  const offlineModelDownloaded = optional(o.offlineModelDownloaded, 'offlineModelDownloaded', (v) =>
    requireBoolean(v, 'offlineModelDownloaded')
  );
  if (offlineModelDownloaded !== undefined) patch.offlineModelDownloaded = offlineModelDownloaded;

  const lastChapterTitle = optional(o.lastChapterTitle, 'lastChapterTitle', (v) =>
    requireString(v, 'lastChapterTitle', LIMITS.title)
  );
  if (lastChapterTitle !== undefined) patch.lastChapterTitle = lastChapterTitle;

  const historyAutoDeleteDays = optional(o.historyAutoDeleteDays, 'historyAutoDeleteDays', (v) =>
    requireInt(v, 'historyAutoDeleteDays', 0, 36_500)
  );
  if (historyAutoDeleteDays !== undefined) patch.historyAutoDeleteDays = historyAutoDeleteDays;

  return patch;
}

export function validateTranslateRequest(raw: unknown): TranslateRequest {
  const o = asRecord(raw, 'translate request');
  const req: TranslateRequest = {
    text: requireString(o.text, 'text', LIMITS.text, 1),
    systemPrompt: requireString(o.systemPrompt, 'systemPrompt', LIMITS.systemPrompt),
  };
  const chapterTitle = optional(o.chapterTitle, 'chapterTitle', (v) =>
    requireString(v, 'chapterTitle', LIMITS.title)
  );
  if (chapterTitle !== undefined) req.chapterTitle = chapterTitle;
  return req;
}

export function validateGlossaryId(raw: unknown): string {
  return requireString(raw, 'glossaryId', LIMITS.id, 1);
}

export function validateGlossaryName(raw: unknown): string {
  return requireString(raw, 'name', LIMITS.name);
}

export function validateActiveGlossaryId(raw: unknown): string | null {
  return nullable(raw, 'activeGlossaryId', (v) =>
    requireString(v, 'activeGlossaryId', LIMITS.id, 1)
  );
}

export function validateGlossaryEntries(raw: unknown): GlossaryEntry[] {
  if (!Array.isArray(raw)) fail('entries 必须是数组');
  if (raw.length > LIMITS.glossaryEntries) {
    fail(`entries 最多 ${LIMITS.glossaryEntries} 条（实际 ${raw.length}）`);
  }
  return raw.map((item, i) => {
    const o = asRecord(item, `entries[${i}]`);
    return {
      source: requireString(o.source, `entries[${i}].source`, LIMITS.glossaryTerm),
      target: requireString(o.target, `entries[${i}].target`, LIMITS.glossaryTerm),
    };
  });
}

export function validateHistoryQuery(raw: unknown): HistoryQuery {
  const o = asRecord(raw, 'history query');
  const query: HistoryQuery = {
    page: requireInt(o.page, 'page', 1, 1_000_000),
    pageSize: requireInt(o.pageSize, 'pageSize', 1, 200),
  };
  const search = optional(o.search, 'search', (v) => requireString(v, 'search', LIMITS.search));
  if (search !== undefined) query.search = search;
  return query;
}

export function validateHistoryId(raw: unknown): number {
  return requireInt(raw, 'id', 1, Number.MAX_SAFE_INTEGER);
}

/** Retention window for "clear history older than N days". */
export function validateRetentionDays(raw: unknown): number {
  return requireInt(raw, 'days', 1, 36_500);
}

export function validateHistoryExport(raw: unknown): HistoryExport {
  const o = asRecord(raw, 'export request');
  return { kind: requireOneOf(o.kind, 'kind', ['csv', 'json'] as const) };
}

export function validateHotkey(raw: unknown): string {
  return requireString(raw, 'accelerator', LIMITS.hotkey, 1);
}

export function validateEpubRequest(raw: unknown): EpubRequest {
  const o = asRecord(raw, 'epub request');
  const chapters = o.chapters;
  if (!Array.isArray(chapters)) fail('chapters 必须是数组');
  if (chapters.length < 1 || chapters.length > LIMITS.epubChapters) {
    fail(`chapters 数量必须在 1..${LIMITS.epubChapters} 之间（实际 ${chapters.length}）`);
  }
  return {
    defaultTitle: requireString(o.defaultTitle, 'defaultTitle', LIMITS.title),
    chapters: chapters.map((item, i) => {
      const c = asRecord(item, `chapters[${i}]`);
      return {
        title: requireString(c.title, `chapters[${i}].title`, LIMITS.title),
        original: requireString(c.original, `chapters[${i}].original`, LIMITS.epubBody),
        translated: requireString(c.translated, `chapters[${i}].translated`, LIMITS.epubBody),
      };
    }),
  };
}