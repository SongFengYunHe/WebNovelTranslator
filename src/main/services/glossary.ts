/**
 * Glossary persistence (plain JSON in <userData>/translator-data/glossaries.json)
 * so users can back the file up / edit it directly. Preserves the v1 file
 * format exactly.
 *
 * 术语表以 JSON 文件形式持久化：便于用户直接备份/编辑，同时保持 v1 格式兼容。
 * 术语表会在翻译提示词中按 source -> target 注入，提升人名/专有名词翻译一致性。
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { Glossary, GlossaryEntry } from '../../shared/types';
import log from '../logger';

export function glossariesFile(): string {
  return path.join(app.getPath('userData'), 'translator-data', 'glossaries.json');
}

export function loadGlossaries(): Glossary[] {
  try {
    const p = glossariesFile();
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    log.error('[glossary] failed to load glossaries:', err);
  }
  return [];
}

export function saveGlossaries(list: Glossary[]): void {
  try {
    const p = glossariesFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    log.error('[glossary] failed to save glossaries:', err);
  }
}

export function getGlossaryById(id: string | null | undefined): Glossary | null {
  if (!id) return null;
  return loadGlossaries().find((g) => g.id === id) ?? null;
}

// 生成短随机 ID（时间戳 36 进制 + 随机片段），足够避免碰撞。
export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- CRUD (used by the IPC handlers) ---------------------------------------

export function createGlossary(name: string): Glossary {
  const glossary: Glossary = {
    id: genId(),
    name: name?.trim() || 'New Glossary',
    entries: [],
  };
  const list = loadGlossaries();
  list.push(glossary);
  saveGlossaries(list);
  return glossary;
}

export function renameGlossary(id: string, name: string): Glossary[] {
  const list = loadGlossaries();
  const g = list.find((x) => x.id === id);
  if (g && name?.trim()) g.name = name.trim();
  saveGlossaries(list);
  return list;
}

export function deleteGlossary(id: string): Glossary[] {
  const list = loadGlossaries().filter((x) => x.id !== id);
  saveGlossaries(list);
  return list;
}

export function updateGlossaryEntries(id: string, entries: GlossaryEntry[]): Glossary[] {
  const list = loadGlossaries();
  const g = list.find((x) => x.id === id);
  if (g) g.entries = Array.isArray(entries) ? entries : [];
  saveGlossaries(list);
  return list;
}
