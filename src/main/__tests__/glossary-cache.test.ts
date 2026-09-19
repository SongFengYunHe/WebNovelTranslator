import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// glossary.ts 依赖 electron 的 app.getPath；用环境变量指向临时目录，避免触碰真实用户数据。
vi.mock('electron', () => ({
  app: { getPath: () => process.env.WNT_GLOSSARY_DIR || 'wnt-no-dir' },
}));
vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getGlossaryById, loadGlossaries, saveGlossaries } from '../services/glossary';
import type { Glossary } from '../../shared/types';

let dir = '';
let file = '';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wnt-glossary-'));
  process.env.WNT_GLOSSARY_DIR = dir;
  file = path.join(dir, 'translator-data', 'glossaries.json');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.WNT_GLOSSARY_DIR;
});

// 每个用例先删掉文件并读一次：stamp 变为 null，缓存被重置为空表。
beforeEach(() => {
  fs.rmSync(file, { force: true });
  loadGlossaries();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('glossary 读取缓存', () => {
  it('文件不存在时返回空数组且不会顺手建文件', () => {
    expect(loadGlossaries()).toEqual([]);
    expect(getGlossaryById('missing')).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('JSON 损坏时返回空数组而不抛异常（best-effort）', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf-8');
    expect(() => loadGlossaries()).not.toThrow();
    expect(loadGlossaries()).toEqual([]);
  });

  it('保存后读到的是最新数据', () => {
    const g: Glossary = { id: 'g1', name: '术语', entries: [{ source: '火', target: 'fire' }] };
    saveGlossaries([g]);
    expect(loadGlossaries()).toEqual([g]);
    expect(getGlossaryById('g1')).toEqual(g);
  });

  it('文件未变时命中缓存，不再读盘', () => {
    saveGlossaries([{ id: 'g1', name: 'A', entries: [] }]);
    loadGlossaries(); // 预热缓存
    const spy = vi.spyOn(fs, 'readFileSync');
    loadGlossaries();
    loadGlossaries();
    expect(spy).not.toHaveBeenCalled();
  });

  it('保存会失效缓存，后续读取拿到新数据', () => {
    saveGlossaries([{ id: 'g1', name: 'A', entries: [] }]);
    expect(getGlossaryById('g1')?.name).toBe('A');
    saveGlossaries([{ id: 'g1', name: 'B', entries: [] }]);
    expect(getGlossaryById('g1')?.name).toBe('B');
  });

  it('用户在外部直接编辑文件后也能读到变更', () => {
    saveGlossaries([{ id: 'g1', name: 'A', entries: [] }]);
    expect(loadGlossaries()).toHaveLength(1);

    // 绕过 saveGlossaries 直接改盘，模拟用户手工编辑 JSON。
    const edited: Glossary[] = [{ id: 'g2', name: '外部编辑后的名字', entries: [] }];
    fs.writeFileSync(file, JSON.stringify(edited, null, 2), 'utf-8');
    expect(loadGlossaries()).toEqual(edited);
  });
});