import { describe, expect, it } from 'vitest';
import {
  IpcValidationError,
  validateEpubRequest,
  validateGlossaryEntries,
  validateGlossaryId,
  validateHistoryExport,
  validateHistoryQuery,
  validateRetentionDays,
  validateSaveSettingsPatch,
  validateTranslateRequest,
} from '../ipc-validate';

/** 断言该调用以 IpcValidationError 被拒绝。 */
function expectReject(fn: () => unknown): void {
  expect(fn).toThrow(IpcValidationError);
}

describe('validateTranslateRequest', () => {
  it('accepts a well-formed request and keeps an optional chapter title', () => {
    expect(
      validateTranslateRequest({ text: 'hello', systemPrompt: 'sys', chapterTitle: '第一章' })
    ).toEqual({ text: 'hello', systemPrompt: 'sys', chapterTitle: '第一章' });
  });

  it('rejects non-objects, missing fields and empty text', () => {
    expectReject(() => validateTranslateRequest(null));
    expectReject(() => validateTranslateRequest('text'));
    expectReject(() => validateTranslateRequest({ systemPrompt: 'sys' }));
    expectReject(() => validateTranslateRequest({ text: '', systemPrompt: 'sys' }));
  });

  it('rejects oversized text instead of forwarding it to the API', () => {
    expectReject(() =>
      validateTranslateRequest({ text: 'x'.repeat(500_001), systemPrompt: 'sys' })
    );
  });
});

describe('validateSaveSettingsPatch', () => {
  it('accepts a valid patch and drops unknown keys', () => {
    expect(
      validateSaveSettingsPatch({ model: 'gpt-4o', temperature: 0.3, injected: 'nope' })
    ).toEqual({ model: 'gpt-4o', temperature: 0.3 });
  });

  it('rejects out-of-range numeric fields', () => {
    expectReject(() => validateSaveSettingsPatch({ temperature: 3 }));
    expectReject(() => validateSaveSettingsPatch({ maxTokens: 0 }));
    expectReject(() => validateSaveSettingsPatch({ maxTokens: 1.5 }));
    expectReject(() => validateSaveSettingsPatch({ historyAutoDeleteDays: -1 }));
  });

  it('rejects unknown enum values', () => {
    expectReject(() => validateSaveSettingsPatch({ provider: 'openai' }));
    expectReject(() => validateSaveSettingsPatch({ uiLanguage: 'fr' }));
  });

  it('accepts an explicit null active glossary but not a wrong type', () => {
    expect(validateSaveSettingsPatch({ activeGlossaryId: null })).toEqual({
      activeGlossaryId: null,
    });
    expectReject(() => validateSaveSettingsPatch({ activeGlossaryId: 7 }));
  });

  it('returns an empty patch for an empty object rather than throwing', () => {
    expect(validateSaveSettingsPatch({})).toEqual({});
  });
});

describe('validateGlossaryEntries', () => {
  it('maps valid entries', () => {
    expect(validateGlossaryEntries([{ source: '火球术', target: 'Fireball' }])).toEqual([
      { source: '火球术', target: 'Fireball' },
    ]);
  });

  it('rejects a non-array and malformed rows', () => {
    expectReject(() => validateGlossaryEntries({}));
    expectReject(() => validateGlossaryEntries([{ source: 'a' }]));
    expectReject(() => validateGlossaryEntries(['a']));
  });

  it('caps the list so a hostile renderer cannot exhaust memory', () => {
    const tooMany = Array.from({ length: 10_001 }, () => ({ source: 'a', target: 'b' }));
    expectReject(() => validateGlossaryEntries(tooMany));
  });
});

describe('validateHistoryQuery', () => {
  it('accepts a valid page request', () => {
    expect(validateHistoryQuery({ page: 1, pageSize: 20, search: 'abc' })).toEqual({
      page: 1,
      pageSize: 20,
      search: 'abc',
    });
  });

  it('rejects non-integer or out-of-range paging', () => {
    expectReject(() => validateHistoryQuery({ page: 0, pageSize: 20 }));
    expectReject(() => validateHistoryQuery({ page: 1, pageSize: 0 }));
    expectReject(() => validateHistoryQuery({ page: 1, pageSize: 201 }));
    expectReject(() => validateHistoryQuery({ page: 1.5, pageSize: 20 }));
  });
});

describe('validateRetentionDays', () => {
  it('requires a positive whole number of days', () => {
    expect(validateRetentionDays(30)).toBe(30);
    // 0 意味着「删除此刻之前的一切」——永远不是合法请求。
    expectReject(() => validateRetentionDays(0));
    expectReject(() => validateRetentionDays(-5));
    expectReject(() => validateRetentionDays('30'));
  });
});

describe('validateGlossaryId', () => {
  it('requires a non-empty bounded string', () => {
    expect(validateGlossaryId('abc')).toBe('abc');
    expectReject(() => validateGlossaryId(''));
    expectReject(() => validateGlossaryId('x'.repeat(65)));
    expectReject(() => validateGlossaryId(42));
  });
});

describe('validateHistoryExport', () => {
  it('accepts only the two supported formats', () => {
    expect(validateHistoryExport({ kind: 'csv' })).toEqual({ kind: 'csv' });
    expect(validateHistoryExport({ kind: 'json' })).toEqual({ kind: 'json' });
    expectReject(() => validateHistoryExport({ kind: 'xml' }));
    expectReject(() => validateHistoryExport({}));
  });
});

describe('validateEpubRequest', () => {
  const chapter = { title: '第一章', original: 'a', translated: 'b' };

  it('accepts a valid request', () => {
    expect(validateEpubRequest({ chapters: [chapter], defaultTitle: 'novel' })).toEqual({
      chapters: [chapter],
      defaultTitle: 'novel',
    });
  });

  it('requires at least one chapter', () => {
    expectReject(() => validateEpubRequest({ chapters: [], defaultTitle: 'novel' }));
    expectReject(() => validateEpubRequest({ chapters: 'x', defaultTitle: 'novel' }));
  });

  it('rejects a chapter with a non-string body', () => {
    expectReject(() =>
      validateEpubRequest({
        chapters: [{ title: 't', original: 1, translated: 'b' }],
        defaultTitle: 'novel',
      })
    );
  });
});