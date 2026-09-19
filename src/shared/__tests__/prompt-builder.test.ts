import { describe, expect, it } from 'vitest';
import { LANG_LABELS, applyGlossaryToText, buildSystemPrompt } from '../prompt-builder';
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
    const prompt = buildSystemPrompt('zh', 'en', null);
    expect(prompt).toContain(`from ${LANG_LABELS.zh} to ${LANG_LABELS.en}`);
  });

  it('leaves no unresolved placeholders behind', () => {
    const prompt = buildSystemPrompt('ja', 'ko', glossary);
    expect(prompt).not.toMatch(/\{(sourceLang|targetLang|glossary|languageSpecificRules)\}/);
  });

  it('injects glossary entries as `source -> target` lines', () => {
    const prompt = buildSystemPrompt('zh', 'en', glossary);
    expect(prompt).toContain('火球术 -> Fireball Technique');
    expect(prompt).toContain('灵气 -> spiritual energy');
  });

  it('marks an absent or empty glossary as "(none provided)"', () => {
    expect(buildSystemPrompt('zh', 'en', null)).toContain('(none provided)');
    expect(buildSystemPrompt('zh', 'en', emptyGlossary)).toContain('(none provided)');
  });

  it('uses the pair-specific rules when one exists', () => {
    // ja→zh explicitly calls out kanji name conversion.
    expect(buildSystemPrompt('ja', 'zh', null)).toContain('结城明日奈');
  });

  it('falls back to the generic rules for an unlisted pair', () => {
    // zh→ko has no entry in LANGUAGE_RULES.
    expect(buildSystemPrompt('zh', 'ko', null)).toContain('Preserve proper nouns');
  });

  it('keeps `$` sequences in the glossary literal', () => {
    const dollar: Glossary = {
      id: 'g2',
      name: 'money',
      entries: [{ source: '灵石', target: 'costs $$5 & $& more' }],
    };
    // A plain string replacement would collapse `$$` → `$` and expand `$&`.
    expect(buildSystemPrompt('zh', 'en', dollar)).toContain('costs $$5 & $& more');
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
      id: 'g3',
      name: 'partial',
      entries: [
        { source: '', target: 'x' },
        { source: '灵气', target: '' },
      ],
    };
    expect(applyGlossaryToText('灵气', partial)).toBe('灵气');
  });

  // 已知缺陷（P2 阶段处理）：当前为朴素子串替换，单字术语会误伤同字词语。
  it.todo('does not replace a single-character term inside a longer word (P2)');
});