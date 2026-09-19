/**
 * Splits a long chapter into units small enough for a single chat request.
 *
 * Sending a whole chapter in one message risks hitting the model's context
 * limit and produces a wall of text with no way to report progress. Chunking
 * lets the translation run in parallel, report progress and be cancelled.
 *
 * Paragraph structure is preserved: chunks break on paragraph boundaries and
 * the caller rejoins translated chunks with a single newline — exactly the
 * separator the side-by-side view splits on again.
 *
 * Dependency-free so it can be unit tested directly.
 */

/**
 * Soft character budget per chunk. Deliberately conservative: even at ~2 tokens
 * per CJK character this stays well inside the context window of the smallest
 * models the app supports (8k), leaving room for the prompt and the reply.
 */
export const DEFAULT_CHUNK_MAX_CHARS = 3000;

/** Sentence-ish terminators, covering CJK and Latin punctuation. */
const SENTENCE_BREAK = /(?<=[.!?。！？；;])\s*/;

/**
 * Split `text` into chunks of at most `maxChars` characters.
 *
 * Paragraphs are packed greedily. A paragraph that is itself longer than the
 * budget is split on sentence boundaries, and a single oversized sentence is
 * hard-split as a last resort, so no returned chunk ever exceeds `maxChars`.
 *
 * Returns `[]` for blank input.
 */
export function chunkText(text: string, maxChars: number = DEFAULT_CHUNK_MAX_CHARS): string[] {
  const budget = Math.max(1, Math.floor(maxChars));
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return [];

  const chunks: string[] = [];
  let buf: string[] = [];
  let bufLen = 0;

  const flush = () => {
    if (buf.length) {
      chunks.push(buf.join('\n'));
      buf = [];
      bufLen = 0;
    }
  };

  for (const para of paragraphs) {
    if (para.length > budget) {
      flush();
      chunks.push(...splitOversized(para, budget));
      continue;
    }
    // +1 accounts for the newline that will join this paragraph to the buffer.
    const projected = buf.length === 0 ? para.length : bufLen + 1 + para.length;
    if (projected > budget && buf.length > 0) {
      flush();
      buf.push(para);
      bufLen = para.length;
    } else {
      buf.push(para);
      bufLen = projected;
    }
  }
  flush();
  return chunks;
}

/**
 * Break a single oversized paragraph down.
 *
 * Splits on sentence terminators first, then hard-splits any sentence that is
 * still over budget. Only used when one paragraph alone exceeds the whole
 * chunk budget — a rare case (dense dialogue with no blank lines).
 */
function splitOversized(paragraph: string, maxChars: number): string[] {
  const pieces: string[] = [];
  const sentences = paragraph.split(SENTENCE_BREAK).filter((s) => s.length > 0);

  let buf = '';
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (buf) {
        pieces.push(buf);
        buf = '';
      }
      for (let i = 0; i < sentence.length; i += maxChars) {
        pieces.push(sentence.slice(i, i + maxChars));
      }
      continue;
    }
    if (buf.length + sentence.length > maxChars) {
      pieces.push(buf);
      buf = '';
    }
    buf += sentence;
  }
  if (buf) pieces.push(buf);
  return pieces;
}