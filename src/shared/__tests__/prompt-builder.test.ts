import { describe, expect, it } from 'vitest';
import {
  LANG_LABELS,
  applyGlossaryToText,
  buildSystemPrompt,
  filterGlossaryToText,
} from '../prompt-builder';
import type { Glossary } from '../types';

const glossary: Glossary = {
  id: 'g1',
  name: '既定译名',
  entries: [
    { source: '火球术', target: 'Fireball Technique' },
    { source: '灵气', target: 'spiritual energy' },
  ],
};

const emptyGlossary: Glossary = { id: 'g-empty', name: 'empty', entries: [] };

describe('buildSystemPrompt', () => {
  it('renders language codes as their English labels', () => {
    expect(buildSystemPrompt('zh', 'en', null, '任意文本')).toContain(
      `from ${LANG_LABELS.zh} to ${LANG_LABELS.en}`
    );
  });

  it('leaves no unresolved placeholders behind', () => {
    const prompt = buildSystemPrompt('ja', 'ko', glossary, '火球术');
    expect(prompt).not.toMatch(/\{(sourceLang|targetLang|glossary|languageSpecificRules)\}/);
  });

  it('injects only the glossary entries present in the text', () => {
    const prompt = buildSystemPrompt('zh', 'en', glossary, '他施展了火球术。');
    expect(prompt).toContain('火球术 -> Fireball Technique');
    expect(prompt).not.toContain('灵气 -> spiritual energy');
  });

  it('marks an absent, empty or unmatched glossary as "(none provided)"', () => {
    expect(buildSystemPrompt('zh', 'en', null, '任意文本')).toContain('(none provided)');
    expect(buildSystemPrompt('zh', 'en', emptyGlossary, '任意文本')).toContain('(none provided)');
    expect(buildSystemPrompt('zh', 'en', glossary, '与术语无关的文本')).toContain('(none provided)');
  });

  it('uses the pair-specific rules when one exists', () => {
    // ja→zh 明确要求把日文汉字名转换为中文。
    expect(buildSystemPrompt('ja', 'zh', null, 'テキスト')).toContain('结城明日奈');
  });

  it('falls back to the generic rules for an unlisted pair', () => {
    // zh→ko 在 LANGUAGE_RULES 中没有条目。
    expect(buildSystemPrompt('zh', 'ko', null, '文本')).toContain('Preserve proper nouns');
  });

  it('keeps `$` sequences in the glossary literal', () => {
    const dollar: Glossary = {
      id: 'g2',
      name: 'money',
      entries: [{ source: '灵石', target: 'costs $$5 & $& more' }],
    };
    // 普通字符串替换会把 `$$` 折叠成 `$`，并展开 `$&`。
    expect(buildSystemPrompt('zh', 'en', dollar, '灵石')).toContain('costs $$5 & $& more');
  });
});

describe('filterGlossaryToText', () => {
  it('keeps only entries whose source occurs in the text', () => {
    expect(filterGlossaryToText(glossary, '灵气涌动')?.entries).toEqual([
      { source: '灵气', target: 'spiritual energy' },
    ]);
  });

  it('returns the glossary with an empty entry list when nothing matches', () => {
    expect(filterGlossaryToText(glossary, '毫无关联')?.entries).toEqual([]);
  });

  it('passes null through and ignores blank source terms', () => {
    expect(filterGlossaryToText(null, '任意')).toBeNull();
    const withBlank: Glossary = {
      id: 'g3',
      name: 'blank',
      entries: [{ source: '   ', target: 'x' }],
    };
    expect(filterGlossaryToText(withBlank, '任意')?.entries).toEqual([]);
  });
});

describe('applyGlossaryToText', () => {
  it('replaces every occurrence of a source term', () => {
    expect(applyGlossaryToText('火球术！火球术！', glossary)).toBe(
      'Fireball Technique！Fireball Technique！'
    );
  });

  it('returns the text unchanged when there is no glossary content', () => {
    expect(applyGlossaryToText('原文', null)).toBe('原文');
    expect(applyGlossaryToText('原文', emptyGlossary)).toBe('原文');
  });

  it('ignores entries with a blank source or target', () => {
    const partial: Glossary = {
      id: 'g4',
      name: 'partial',
      entries: [
        { source: '', target: 'x' },
        { source: '灵气', target: '' },
      ],
    };
    expect(applyGlossaryToText('灵气', partial)).toBe('灵气');
  });

  it('prefers the longer term when two entries overlap', () => {
    const overlapping: Glossary = {
      id: 'g5',
      name: 'overlap',
      entries: [
        { source: '魔法', target: 'magic' },
        { source: '魔法师', target: 'mage' },
      ],
    };
    expect(applyGlossaryToText('魔法师与魔法', overlapping)).toBe('mage与magic');
  });

  it('does not cascade — a produced target is never re-matched', () => {
    const chained: Glossary = {
      id: 'g6',
      name: 'chain',
      entries: [
        { source: '甲', target: '乙' },
        { source: '乙', target: '丙' },
      ],
    };
    // 甲 -> 乙，而刚产生的 乙「不能」随后再变成 丙。
    expect(applyGlossaryToText('甲', chained)).toBe('乙');
  });

  it('does not replace a single-character CJK term inside a longer word', () => {
    const single: Glossary = {
      id: 'g7',
      name: 'single',
      entries: [{ source: '王', target: 'Wang' }],
    };
    // 王 出现在 王国 / 王子 内部，因此必须保持不变……
    expect(applyGlossaryToText('王国与王子', single)).toBe('王国与王子');
    // ……但独立出现时仍会被翻译。
    expect(applyGlossaryToText('王，你来了', single)).toBe('Wang，你来了');
  });

  it('still replaces a multi-character CJK term adjacent to other characters', () => {
    const multi: Glossary = {
      id: 'g8',
      name: 'multi',
      entries: [{ source: '灵气', target: 'qi' }],
    };
    expect(applyGlossaryToText('灵气涌动', multi)).toBe('qi涌动');
  });

  it('treats regex metacharacters in a term as literals', () => {
    const meta: Glossary = {
      id: 'g9',
      name: 'meta',
      entries: [{ source: 'a.c', target: 'X' }],
    };
    // 点号不能充当通配符。
    expect(applyGlossaryToText('a.c abc', meta)).toBe('X abc');
  });

  it('inserts a target containing `$` literally', () => {
    const dollar: Glossary = {
      id: 'g10',
      name: 'money',
      entries: [{ source: '灵石', target: '$$5' }],
    };
    expect(applyGlossaryToText('灵石', dollar)).toBe('$$5');
  });
});