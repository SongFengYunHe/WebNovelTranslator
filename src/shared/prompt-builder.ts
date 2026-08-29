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
 * Build the full system prompt for the given language pair and glossary.
 */
export function buildSystemPrompt(
  sourceLang: string,
  targetLang: string,
  glossary: Glossary | null
): string {
  const src = LANG_LABELS[sourceLang] ?? sourceLang;
  const tgt = LANG_LABELS[targetLang] ?? targetLang;

  const glossaryText =
    glossary && glossary.entries.length
      ? glossary.entries.map((e) => `${e.source} -> ${e.target}`).join('\n')
      : '(none provided)';

  const rules = LANGUAGE_RULES[`${sourceLang}→${targetLang}`] ?? GENERIC_RULES;

  return SYSTEM_PROMPT_TEMPLATE.replace('{sourceLang}', src)
    .replace('{targetLang}', tgt)
    .replace('{glossary}', glossaryText)
    .replace('{languageSpecificRules}', rules);
}

/**
 * Apply a glossary to already-translated text via simple case-sensitive string
 * replacement (used by offline translation, which has no glossary-awareness).
 */
export function applyGlossaryToText(text: string, glossary: Glossary | null): string {
  if (!glossary || !glossary.entries.length) return text;
  let out = text;
  for (const entry of glossary.entries) {
    const source = entry.source?.trim();
    const target = entry.target?.trim();
    if (source && target && out.includes(source)) {
      out = out.split(source).join(target);
    }
  }
  return out;
}
