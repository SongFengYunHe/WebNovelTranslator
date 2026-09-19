/**
 * 术语表持久化（以纯 JSON 存放在 <userData>/translator-data/glossaries.json），
 * 便于用户直接备份/编辑该文件。完全保持 v1 文件格式。
 *
 * 术语表以 JSON 文件形式持久化：便于用户直接备份/编辑，同时保持 v1 格式兼容。
 * 术语表会在翻译提示词中按 source -> target 注入，提升人名/专有名词翻译一致性。
 * 读取带内存缓存（见 loadGlossaries），因为全局快捷键翻译会高频调用 getGlossaryById。
 */
import { app } from 'electron';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Glossary, GlossaryEntry } from '../../shared/types';
import log from '../logger';

/**
 * loadGlossaries() 的内存缓存：全局快捷键翻译每次都会经 getGlossaryById() 取术语表，
 * 若每次都读盘并 JSON.parse 整个文件，高频场景下纯属浪费。
 */
let cachedGlossaries: Glossary[] | null = null;
/** 缓存对应的文件指纹（mtime:size），用于发现用户直接编辑文件导致的外部变更。 */
let cachedStamp: string | null = null;

/** 文件指纹；文件不存在/不可读时返回 null，表示「没有可用数据」。 */
function fileStamp(p: string): string | null {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

export function glossariesFile(): string {
  return path.join(app.getPath('userData'), 'translator-data', 'glossaries.json');
}

/**
 * 读取术语表。带内存缓存：文件指纹未变时直接复用上次结果。
 * 保持 best-effort 语义——文件缺失或 JSON 损坏时返回空数组而不是抛异常。
 */
export function loadGlossaries(): Glossary[] {
  const p = glossariesFile();
  const stamp = fileStamp(p);
  if (cachedGlossaries && stamp !== null && stamp === cachedStamp) {
    return cachedGlossaries;
  }
  try {
    if (stamp !== null) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      cachedGlossaries = Array.isArray(parsed) ? parsed : [];
    } else {
      cachedGlossaries = [];
    }
  } catch (err) {
    log.error('[glossary] failed to load glossaries:', err);
    // 解析失败时缓存空表：既不把旧数据当有效数据，也避免每次调用都重试损坏的文件。
    cachedGlossaries = [];
  }
  cachedStamp = stamp;
  return cachedGlossaries;
}

export function saveGlossaries(list: Glossary[]): void {
  const p = glossariesFile();
  const tmp = `${p}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const json = JSON.stringify(list, null, 2);
    // 先写入临时文件、刷盘，再重命名覆盖目标。rename() 在同一文件系统上是原子的，
    // 因此写入中途崩溃绝不会留下被截断的 glossaries.json——读取方要么看到上一个
    // 完整文件，要么看到新文件。这是用户术语的唯一一份拷贝。
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, json, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  } catch (err) {
    log.error('[glossary] failed to save glossaries:', err);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore —— 临时文件尽力清理即可 */
    }
  }
  // 无论成败都丢弃缓存：成功时是因为文件已被替换；失败时是因为调用方在此之前
  // 可能已就地改过缓存中的对象（CRUD 都是先 load 再改再 save），必须回读磁盘纠正。
  cachedGlossaries = null;
  cachedStamp = null;
}

export function getGlossaryById(id: string | null | undefined): Glossary | null {
  if (!id) return null;
  return loadGlossaries().find((g) => g.id === id) ?? null;
}

// ---- CRUD（供 IPC 处理器使用）---------------------------------------------

export function createGlossary(name: string): Glossary {
  const glossary: Glossary = {
    id: randomUUID(),
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
