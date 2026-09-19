import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_MAX_CHARS, chunkText } from '../chunking';

/** The paragraph list a chunked result is expected to represent. */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

describe('chunkText', () => {
  it('returns nothing for blank input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  \t ')).toEqual([]);
  });

  it('keeps short text in a single chunk', () => {
    expect(chunkText('第一段\n\n第二段', 100)).toEqual(['第一段\n第二段']);
  });

  it('packs paragraphs greedily up to the budget', () => {
    const text = 'aaaa\nbbbb\ncccc';
    // "aaaa\nbbbb" is 9 chars, adding "\ncccc" would make 14 > 10.
    expect(chunkText(text, 10)).toEqual(['aaaa\nbbbb', 'cccc']);
  });

  it('preserves every paragraph across the split', () => {
    const text = Array.from({ length: 40 }, (_, i) => `第${i}段的内容`).join('\n\n');
    const chunks = chunkText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    const reassembled = chunks.flatMap(paragraphsOf);
    expect(reassembled).toEqual(paragraphsOf(text));
  });

  it('never returns a chunk longer than the budget', () => {
    const text = ['短段', 'x'.repeat(250), '另一个短段', 'y'.repeat(1000)].join('\n\n');
    for (const budget of [10, 50, 120, 300]) {
      for (const chunk of chunkText(text, budget)) {
        expect(chunk.length).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('splits one oversized paragraph on sentence boundaries', () => {
    const sentence = '这是一个句子。';
    const paragraph = sentence.repeat(20); // 140 chars, no blank lines
    const chunks = chunkText(paragraph, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(60);
      // Sentence terminators stay attached to the sentence they close.
      expect(chunk.endsWith('。')).toBe(true);
    }
    expect(chunks.join('')).toBe(paragraph);
  });

  it('hard-splits a single sentence that exceeds the budget', () => {
    const paragraph = 'z'.repeat(250);
    const chunks = chunkText(paragraph, 100);
    expect(chunks.length).toBe(3);
    expect(chunks.join('')).toBe(paragraph);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it('trims whitespace and drops empty paragraphs', () => {
    expect(chunkText('  第一段  \n\n\n\n   \n\n 第二段  ', 100)).toEqual(['第一段\n第二段']);
  });

  it('exposes a conservative default budget', () => {
    expect(DEFAULT_CHUNK_MAX_CHARS).toBeGreaterThan(1000);
    expect(DEFAULT_CHUNK_MAX_CHARS).toBeLessThanOrEqual(4000);
  });
});