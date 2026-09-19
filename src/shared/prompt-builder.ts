/**
 * 动态提示词组装（在主进程与渲染进程之间共享，使全局快捷键 / 离线翻译组装出与
 * 界面完全相同的提示词）。无依赖——只导入 `Glossary` 类型。
 *
 * 系统提示词模板在运行时由以下内容组装：
 *   1. 当前术语表（逐行的 `source -> target` 条目）
 *   2. 针对语言对的规则
 */
import type { Glossary } from './types';

export const LANG_LABELS: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
};

/** 语言对规则。可扩展：新增一个如 `fr→en` 的键并配上自己的规则即可。 */
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
 * 把术语表收窄到其源术语确实出现在 `text` 中的条目。
 *
 * 整个启用中的术语表都会被注入提示词，因此一份庞大的术语表（数百个修炼术语、
 * 人名、地名）可能挤占章节本身。过滤出该段落中出现的术语，能让提示词保持精简，
 * 并让模型的注意力集中在文本上。
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
 * 为给定的语言对与术语表构建完整的系统提示词。
 *
 * `text` 是即将被翻译的段落——术语表在被注入前会先过滤为它实际包含的术语。
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

  // 每处替换都使用函数，使注入文本中的 `$&` / `$$` / `$'` 被当作字面量。若用
  // 普通字符串替换，含有 `$$`（或任何 `$` 模式）的术语会被悄悄破坏。
  return SYSTEM_PROMPT_TEMPLATE.replace('{sourceLang}', () => src)
    .replace('{targetLang}', () => tgt)
    .replace('{glossary}', () => glossaryText)
    .replace('{languageSpecificRules}', () => rules);
}

/** CJK 码点范围，用于在没有分词器的情况下判断相邻性。 */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RANGES = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';

/** 用于暂存替换结果的零宽标记，避免它被再次匹配。 */
const MARK = '\u0000';

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 为单个术语表的源术语构建匹配模式。
 *
 * 单个 CJK 字符是危险情形：作为裸子串它会匹配任意更长词内部的字符，因此条目
 * 王 -> Wang 会把 王国 破坏成 Wang国。要求在两侧各有一个非 CJK 字符，即可把这类
 * 术语限制在独立出现的场合。更长的术语足够具体，可直接匹配。
 */
function termPattern(source: string): string {
  const escaped = escapeRegExp(source);
  if (source.length === 1 && CJK_CHAR.test(source)) {
    return `(?<![${CJK_RANGES}])${escaped}(?![${CJK_RANGES}])`;
  }
  return escaped;
}

/**
 * 把术语表应用到已翻译的文本上。
 *
 * 用于离线翻译：NLLB 模型没有术语表感知能力，后处理是唯一选择。三条规则保证安全：
 *
 *  1. 较长的源术语先执行，因此 魔法师 优先于 魔法。
 *  2. 每处替换先暂存在占位符之后，因此由先前规则产生的文本绝不会被后续规则再次
 *     匹配（过去 A->B 与 B->C 会级联）。
 *  3. 单字符 CJK 术语必须独立出现（见 `termPattern`）。
 *
 * 替换以回调方式应用，因此含有 `$&` 或 `$$` 的目标会被原样插入。
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
