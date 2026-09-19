/**
 * Translation history persisted with better-sqlite3 in the user data folder
 * (Part A2).
 *
 *  DB file : <userData>/translator-data/history.db
 *  Schema  : id, source_text, translated_text, source_lang, target_lang,
 *            glossary_id, timestamp, chapter_title (optional)
 *
 * better-sqlite3 is synchronous, which is fine here: writes are single-row and
 * rare, and the main process is the only writer.
 */
import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { DatabaseHealth, HistoryEntry, HistoryPage, HistoryQuery } from '../../shared/types';
import log from '../logger';

let db: Database.Database | null = null;
/** Set once initialisation has failed, so every later call does not retry it. */
let initFailed = false;
/** Human-readable reason for the last initialisation failure; null while healthy. */
let lastError: string | null = null;

function dataDir(): string {
  return path.join(app.getPath('userData'), 'translator-data');
}

function dbPath(): string {
  return path.join(dataDir(), 'history.db');
}

/**
 * Open (or create) the history database. Safe to call multiple times.
 * Also guarantees the `translator-data` directory exists (Part E7).
 */
export function initDatabase(): void {
  if (db || initFailed) return;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const file = dbPath();
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        source_text     TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        source_lang     TEXT NOT NULL DEFAULT 'zh',
        target_lang     TEXT NOT NULL DEFAULT 'en',
        glossary_id     TEXT,
        timestamp       INTEGER NOT NULL,
        chapter_title   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_history_chapter ON history(chapter_title);
    `);
    lastError = null;
    log.info(`[db] history database ready at ${file}`);
  } catch (err) {
    // Record the reason instead of only logging it: history silently degrading
    // into a no-op is confusing, so the UI reads this via getDatabaseStatus().
    initFailed = true;
    lastError = (err as Error).message;
    db = null;
    log.error('[db] failed to initialize database:', err);
  }
}

/**
 * Current health. Triggers a lazy open first so the very first call reflects
 * reality rather than an untried connection.
 */
export function getDatabaseStatus(): DatabaseHealth {
  getDb();
  return { ok: db !== null, error: lastError, path: dbPath() };
}

/** Drop-in safe accessor; returns null when the DB failed to open. */
function getDb(): Database.Database | null {
  if (!db) initDatabase();
  return db;
}

export function insertHistory(entry: {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  glossaryId: string | null;
  chapterTitle: string | null;
}): HistoryEntry | null {
  const d = getDb();
  if (!d) return null;
  const now = Date.now();
  const info = d
    .prepare(
      `INSERT INTO history
         (source_text, translated_text, source_lang, target_lang, glossary_id, timestamp, chapter_title)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.sourceText,
      entry.translatedText,
      entry.sourceLang,
      entry.targetLang,
      entry.glossaryId,
      now,
      entry.chapterTitle
    );
  const row = d
    .prepare('SELECT * FROM history WHERE id = ?')
    .get(info.lastInsertRowid) as HistoryEntry | undefined;
  return row ?? null;
}

function toRow(r: unknown): HistoryEntry {
  return r as HistoryEntry;
}

export function queryHistory(query: HistoryQuery): HistoryPage {
  const d = getDb();
  const page = Math.max(1, Math.floor(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize) || 20));
  const search = (query.search ?? '').trim();

  const where = search ? `WHERE source_text LIKE ? OR translated_text LIKE ? OR COALESCE(chapter_title, '') LIKE ?` : '';
  const like = `%${search}%`;
  const params = search ? [like, like, like] : [];

  if (!d) {
    return { items: [], total: 0, page, pageSize };
  }

  const total = (d.prepare(`SELECT COUNT(*) AS n FROM history ${where}`).get(...params) as { n: number }).n;
  const items = d
    .prepare(
      `SELECT * FROM history ${where}
       ORDER BY timestamp DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize)
    .map(toRow);

  return { items, total, page, pageSize };
}

/** All rows, newest first — used for CSV/JSON export. */
export function allHistory(): HistoryEntry[] {
  const d = getDb();
  if (!d) return [];
  return d
    .prepare('SELECT * FROM history ORDER BY timestamp DESC, id DESC')
    .all()
    .map(toRow);
}

export function deleteHistory(id: number): boolean {
  const d = getDb();
  if (!d) return false;
  const info = d.prepare('DELETE FROM history WHERE id = ?').run(id);
  return info.changes > 0;
}

export function clearHistory(): boolean {
  const d = getDb();
  if (!d) return false;
  d.prepare('DELETE FROM history').run();
  // Reclaim disk space so the file shrinks after a full clear.
  d.pragma('wal_checkpoint(TRUNCATE)');
  d.exec('VACUUM');
  return true;
}

/** 删除早于 `days` 天的历史记录，返回删除条数（历史自动清理逻辑）。 */
export function deleteHistoryOlderThan(days: number): number {
  const d = getDb();
  if (!d) return 0;
  const cutoff = Date.now() - Math.max(1, Math.floor(days)) * 24 * 60 * 60 * 1000;
  const info = d.prepare('DELETE FROM history WHERE timestamp < ?').run(cutoff);
  if (info.changes > 0) {
    // 同样回收磁盘空间，避免数据库无限增长。
    d.pragma('wal_checkpoint(TRUNCATE)');
    d.exec('VACUUM');
  }
  return info.changes;
}

export function countHistory(): number {
  const d = getDb();
  if (!d) return 0;
  const row = d.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number };
  return row.n;
}

/** Close the database connection (Part E2: clean shutdown). */
export function closeDatabase(): void {
  if (db) {
    try {
      db.close();
    } catch (err) {
      log.warn('[db] error closing database:', err);
    }
    db = null;
    log.info('[db] database connection closed');
  }
}
