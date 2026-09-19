/**
 * Dynamic prompt assembly (shared between the main process and the renderer so
 * global-hotkey / offline translation compose the exact same prompt the UI
 * does). Dependency-free — only imports the `Glossary` type.
 *
 * The system prompt template is composed at runtime with:
 *   1. the active glossary (line-separated `source -> target` entries)
 *   2. language-pair-specific rules
 */
import type { Glossary } from './types';

export const LANG_LABELS: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
};

/** Language-pair rules. Extensible: add a new key like `fr→en` with its own rules. */
const LANGUAGE_RULES: Record<string, string> = {
  'zh→en': `Use vivid, engaging English suited to web novels.
• Translate character names into pinyin.
• Render cultivation/special terms in pinyin italics with a brief explanation on first occurrence.
• Convert Chinese quotation marks «» to English quotation marks.
• Keep action scenes fast-paced and immersive.`,

  'en→zh': `Use idiomatic, immersive Chinese web-novel style (网文风格).
• Translate names via common transliteration (e.g., John→约翰).
• Convert measurements to metric units.
• Use Chinese punctuation (“”, 。).
• Keep the pace brisk and bingeable.`,

  'ja→zh': `Convert Japanese kanji names directly to Simplified Chinese (e.g., 結城明日奈→结城明日奈).
• Replace honorifics naturally or drop them as appropriate.
• Convert katakana loanwords to Chinese equivalents (e.g., マジック→魔法).
• Use Chinese punctuation.`,

  'zh→ja': `Retain Chinese characters for proper nouns.
• Adapt the tone to a light novel.
• Use Japanese quotation marks 「」.
• Convert Chinese idioms into natural Japanese expressions.`,

  'en→ja': `Adapt the text for the Japanese web novel / light novel market.
• Use Japanese quotation marks 「」.
• Use honorifics (さん/くん/ちゃん) naturally.
• Keep names romanized or use common Japanese renderings.
• Use a natural light-novel tone.`,

  'ja→en': `Adapt the text for the English web novel market.
• Render honorifics naturally or drop them where they carry no meaning.
• Keep Japanese terms that add flavor, with a brief explanation on first occurrence.
• Use English quotation marks.
• Keep the prose vivid and fast-paced.`,
};

const GENERIC_RULES = `Use natural, fluent, vivid prose appropriate for a web novel.
• Preserve proper nouns.
• Use the target language's standard punctuation and quotation marks.
• Keep the tone immersive and fast-paced.`;

const SYSTEM_PROMPT_TEMPLATE = `You are an expert literary translator specializing in web novels. Translate the following text from {sourceLang} to {targetLang}, strictly following the glossary and rules below.

Glossary (Highest Priority - MUST follow exactly)
{glossary}

Translation Rules
{languageSpecificRules}

Formatting
· Preserve original paragraph breaks and any HTML/XML tags. Never translate or modify tags.
· Maintain a fast-paced, immersive tone characteristic of web novels.
· Output ONLY the translation, no extra commentary.

Now, translate the following text:`;

/**
 * Narrow a glossary down to the entries whose source term actually occurs in
 * `text`.
 *
 * The whole active glossary is injected into the prompt, so a large one
 * (hundreds of cultivation terms, character names, place names) can crowd out
 * the chapter itself. Filtering to the terms present in the passage keeps the
 * prompt small and the model's attention on the text.
 */
export function filterGlossaryToText(glossary: Glossary | null, text: string): Glossary | null {
  if (!glossary) return null;
  const entries = glossary.entries.filter((e) => {
    const source = e.source?.trim();
    return Boolean(source) && text.includes(source);
  });
  return { ...glossary, entries };
}

/**
 * Build the full system prompt for the given language pair and glossary.
 *
 * `text` is the passage about to be translated — the glossary is filtered to
 * the terms it actually contains before being injected.
 */
export function buildSystemPrompt(
  sourceLang: string,
  targetLang: string,
  glossary: Glossary | null,
  text: string
): string {
  const src = LANG_LABELS[sourceLang] ?? sourceLang;
  const tgt = LANG_LABELS[targetLang] ?? targetLang;

  const matched = filterGlossaryToText(glossary, text);
  const glossaryText =
    matched && matched.entries.length
      ? matched.entries.map((e) => `${e.source} -> ${e.target}`).join('\n')
      : '(none provided)';

  const rules = LANGUAGE_RULES[`${sourceLang}→${targetLang}`] ?? GENERIC_RULES;

  // Every replacement uses a function so `$&` / `$$` / `$'` inside the injected
  // text are treated as literals. With a plain string replacement, a glossary
  // term containing `$$` (or any `$`-pattern) would be silently mangled.
  return SYSTEM_PROMPT_TEMPLATE.replace('{sourceLang}', () => src)
    .replace('{targetLang}', () => tgt)
    .replace('{glossary}', () => glossaryText)
    .replace('{languageSpecificRules}', () => rules);
}

/** CJK code-point ranges, used to reason about adjacency without a tokenizer. */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RANGES = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';

/** Zero-width marker used to park a replacement so it cannot be re-matched. */
const MARK = '\u0000';

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the match pattern for one glossary source term.
 *
 * A single CJK character is the dangerous case: as a bare substring it matches
 * inside any longer word, so the entry 王 -> Wang would corrupt 王国 into
 * Wang国. Requiring a non-CJK character on both sides confines such a term to
 * stand-alone occurrences. Longer terms are specific enough to match directly.
 */
function termPattern(source: string): string {
  const escaped = escapeRegExp(source);
  if (source.length === 1 && CJK_CHAR.test(source)) {
    return `(?<![${CJK_RANGES}])${escaped}(?![${CJK_RANGES}])`;
  }
  return escaped;
}

/**
 * Apply a glossary to already-translated text.
 *
 * Used by offline translation, where the NLLB model has no glossary awareness
 * and post-processing is the only option. Three rules keep it safe:
 *
 *  1. Longer source terms run first, so 魔法师 wins over 魔法.
 *  2. Each replacement is parked behind a placeholder, so text produced by an
 *     earlier rule can never be re-matched by a later one (A->B plus B->C used
 *     to cascade).
 *  3. Single-character CJK terms must stand alone (see `termPattern`).
 *
 * Replacements are applied with a callback, so a target containing `$&` or `$$`
 * is inserted literally.
 */
export function applyGlossaryToText(text: string, glossary: Glossary | null): string {
  if (!glossary || !glossary.entries.length) return text;

  const entries = glossary.entries
    .map((e) => ({ source: e.source?.trim() ?? '', target: e.target?.trim() ?? '' }))
    .filter((e) => e.source && e.target && text.includes(e.source))
    .sort((a, b) => b.source.length - a.source.length);

  if (!entries.length) return text;

  const targets: string[] = [];
  let out = text;
  for (const entry of entries) {
    out = out.replace(new RegExp(termPattern(entry.source), 'g'), () => {
      targets.push(entry.target);
      return `${MARK}${targets.length - 1}${MARK}`;
    });
  }

  return out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_m, i: string) => targets[Number(i)] ?? '');
}
