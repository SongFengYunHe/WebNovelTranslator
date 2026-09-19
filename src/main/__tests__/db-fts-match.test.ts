import { describe, expect, it, vi } from 'vitest';

// db.ts 依赖 electron 与 better-sqlite3（后者在 CI 中按 Electron ABI 编译，纯 Node 下
// 无法 require）。这里把它们替换成空壳，只为了能 import 其中的纯函数做单测。
vi.mock('electron', () => ({ app: { getPath: () => 'wnt-test' } }));
vi.mock('better-sqlite3', () => ({ default: class {} }));
vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { FTS_MIN_QUERY_LENGTH, buildFtsMatch } from '../services/db';

describe('buildFtsMatch', () => {
  it('把足够长的关键词包成 FTS5 字符串字面量', () => {
    expect(buildFtsMatch('translation')).toBe('"translation"');
    expect(buildFtsMatch('第一章')).toBe('"第一章"');
  });

  it('去除首尾空白后再判断长度', () => {
    expect(buildFtsMatch('  译文表  ')).toBe('"译文表"');
    expect(buildFtsMatch('  ab  ')).toBeNull();
  });

  it('短于 3 字符时返回 null，让调用方回落 LIKE（trigram 无法命中）', () => {
    expect(FTS_MIN_QUERY_LENGTH).toBe(3);
    expect(buildFtsMatch('')).toBeNull();
    expect(buildFtsMatch('   ')).toBeNull();
    expect(buildFtsMatch('火')).toBeNull();
    expect(buildFtsMatch('ab')).toBeNull();
    expect(buildFtsMatch('abc')).toBe('"abc"');
  });

  it('把内嵌双引号翻倍转义，避免破坏字面量', () => {
    expect(buildFtsMatch('a"b"c')).toBe('"a""b""c"');
    expect(buildFtsMatch('"')).toBeNull(); // 单个引号长度不足
    expect(buildFtsMatch('""""')).toBe('"' + '""""""""' + '"');
  });

  it('把 FTS 运算符当普通文本处理，避免语法报错或语义变化', () => {
    expect(buildFtsMatch('AND OR NOT')).toBe('"AND OR NOT"');
    expect(buildFtsMatch('a* (b)')).toBe('"a* (b)"');
    expect(buildFtsMatch('NEAR(x y)')).toBe('"NEAR(x y)"');
  });

  it('按 Unicode 码点计数，中文与 emoji 不会被拆错', () => {
    expect(buildFtsMatch('你好')).toBeNull(); // 2 个码点
    expect(buildFtsMatch('你好吗')).toBe('"你好吗"');
    expect(buildFtsMatch('😀😀')).toBeNull(); // 代理对按 2 个码点算
    expect(buildFtsMatch('😀😀😀')).toBe('"😀😀😀"');
  });
});