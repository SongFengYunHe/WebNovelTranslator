/**
 * 使用 better-sqlite3 将翻译历史持久化到用户数据目录（A2 部分）。
 *
 *  数据库文件：<userData>/translator-data/history.db
 *  表结构    ：id, source_text, translated_text, source_lang, target_lang,
 *              glossary_id, timestamp, chapter_title（可选）
 *
 * better-sqlite3 是同步的，这里没问题：写入都是单行且罕见，且主进程是唯一的写入者。
 *
 * 全文检索：优先使用 FTS5 虚拟表（trigram 分词器，支持中文子串匹配），
 * 若当前 SQLite 构建未启用 FTS5/trigram，则自动降级为原来的 LIKE 全表扫描。
 * 磁盘回收：删除后走增量 vacuum（廉价）；旧库首次转换所需的整库 VACUUM 被
 * 推迟到删除返回之后的空闲时机，避免同步阻塞主进程。
 */
import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { DatabaseHealth, HistoryEntry, HistoryPage, HistoryQuery } from '../../shared/types';
import log from '../logger';

let db: Database.Database | null = null;
/** 初始化失败后置位，使后续每次调用都不再重试。 */
let initFailed = false;
/** 最近一次初始化失败的可读原因；健康时为 null。 */
let lastError: string | null = null;

/** FTS5 索引是否可用；false 时 queryHistory 回落到 LIKE 全表扫描。 */
let ftsEnabled = false;
/** 库是否已处于 SQLite 增量 vacuum 模式，此时删除后可用廉价的 incremental_vacuum。 */
let incrementalVacuumReady = false;
/** 旧库需要一次整库 VACUUM 才能让 auto_vacuum=INCREMENTAL 真正生效。 */
let needsAutoVacuumConvert = false;
/** 延迟压缩的定时器句柄；非空表示已有一次待执行的压缩。 */
let compactionTimer: ReturnType<typeof setTimeout> | null = null;

function dataDir(): string {
  return path.join(app.getPath('userData'), 'translator-data');
}

function dbPath(): string {
  return path.join(dataDir(), 'history.db');
}

/**
 * 打开（或创建）历史数据库。可安全地多次调用。
 * 同时保证 `translator-data` 目录存在（E7 部分）。
 */
export function initDatabase(): void {
  if (db || initFailed) return;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const file = dbPath();
    db = new Database(file);
    // 顺序要紧：auto_vacuum 必须在任何写入之前设置。`journal_mode = WAL` 会写入
    // 库头、把数据文件实体化，之后再设 auto_vacuum 就不再生效（实测会停留在
    // NONE，导致 incremental_vacuum 变成静默的空操作，空间永不回收）。
    configureAutoVacuum(db);
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
    initFts5(db);
    lastError = null;
    log.info(`[db] history database ready at ${file}`);
  } catch (err) {
    // 记录原因而不是仅写日志：历史功能悄悄退化成空操作会令人困惑，因此界面会
    // 通过 getDatabaseStatus() 读取它。
    initFailed = true;
    lastError = (err as Error).message;
    db = null;
    log.error('[db] failed to initialize database:', err);
  }
}

/**
 * 配置 auto_vacuum。增量模式让删除后的空闲页可被 incremental_vacuum 廉价回收，
 * 从而把整库 VACUUM 移出删除热路径。
 */
function configureAutoVacuum(d: Database.Database): void {
  try {
    // 形状为 [{ auto_vacuum: 0|1|2 }]；0=NONE 1=FULL 2=INCREMENTAL。
    const rows = d.pragma('auto_vacuum') as Array<{ auto_vacuum: number }>;
    const mode = rows[0]?.auto_vacuum ?? 0;
    if (mode === 2) {
      // 2 = INCREMENTAL，已是目标模式。
      incrementalVacuumReady = true;
      return;
    }
    // sqlite_master 里有表说明这是已有数据的旧库；新库此时表数为 0。
    // （注意 FTS5 会生成 history_fts_* 影子表，但那只在首次建表之后出现。）
    const tables = (
      d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as {
        n: number;
      }
    ).n;
    if (tables === 0) {
      d.pragma('auto_vacuum = INCREMENTAL');
      incrementalVacuumReady = true;
    } else {
      // 旧库：单独写 pragma 不会立即改变存储格式，需要一次 VACUUM 才生效。
      // 这里不立刻做（大库可能很慢），留到删除后的空闲时机延迟转换。
      needsAutoVacuumConvert = true;
    }
  } catch (err) {
    log.warn('[db] failed to configure auto_vacuum:', err);
  }
}

/** trigram 分词器按 3 字符滑窗建索引，短于 3 字符的查询无法命中，需回落 LIKE。 */
export const FTS_MIN_QUERY_LENGTH = 3;

/**
 * 把用户输入转换成 FTS5 的 MATCH 表达式；不适用时返回 null（调用方回落 LIKE）。
 *
 * 抽成纯函数是为了单测：db.ts 依赖 electron/better-sqlite3，无法整体单测，
 * 但转义逻辑不依赖任何运行时环境，是最容易出错、也最值得覆盖的部分。
 */
export function buildFtsMatch(raw: string): string | null {
  const term = (raw ?? '').trim();
  if (Array.from(term).length < FTS_MIN_QUERY_LENGTH) return null;
  // 用双引号包成字符串字面量：内部双引号翻倍转义，整体按短语处理，
  // 既不会被当成 FTS 语法关键字（AND/OR/*/( ），配合 trigram 又能做子串匹配。
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * 建立 FTS5 虚拟表、同步触发器，并对旧库做一次性回填。失败时静默降级为 LIKE。
 */
function initFts5(d: Database.Database): void {
  try {
    // 用「虚拟表是否已存在」而不是「索引是否为空」判断升级：外部内容表上的
    // SELECT COUNT(*) 会直接读主表（content table），无法反映索引有无数据。
    const existed = !!d
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'history_fts'")
      .get();
    if (existed) {
      // 索引已存在：只需补齐触发器（幂等）。索引由触发器持续同步，无需重建。
      createFtsTriggers(d);
      ftsEnabled = true;
      return;
    }
    // 首次启用 FTS（全新库，或已有大量数据的旧库）：建表 + 触发器 + 回填必须原子完成，
    // 否则中途崩溃会留下「表存在但为空」的状态，之后再也检测不到需要回填。
    d.exec('BEGIN');
    try {
      // 选用 trigram 分词器：unicode61 会把整段中文当作一个 token，MATCH 无法命中
      // 中文子串；trigram（SQLite 3.34+，better-sqlite3 9.6 内置版本满足）按 3 字符
      // 滑窗建索引，天然支持中文与英文的子串匹配。代价是索引体积更大、短查询需降级。
      // content='history' 表示 FTS 表不重复存储正文（外部内容表），仅存索引。
      d.exec(`
        CREATE VIRTUAL TABLE history_fts USING fts5(
          source_text,
          translated_text,
          chapter_title,
          content='history',
          content_rowid='id',
          tokenize='trigram'
        );
      `);
      createFtsTriggers(d);
      // 回填存量数据：外部内容表用 'rebuild' 从主表重建索引，空表上执行也是幂等的。
      d.exec("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
      d.exec('COMMIT');
    } catch (err) {
      // ROLLBACK 自身失败（例如 SQLite 已自动回滚）不应掩盖原始错误。
      try {
        d.exec('ROLLBACK');
      } catch {
        /* 忽略 */
      }
      throw err;
    }
    ftsEnabled = true;
    log.info('[db] history full-text index (FTS5/trigram) created and backfilled');
  } catch (err) {
    // 某些 SQLite 构建未启用 FTS5 或 trigram；降级到 LIKE 即可，不该让搜索报错。
    ftsEnabled = false;
    log.warn('[db] FTS5 unavailable, history search falls back to LIKE:', err);
  }
}

/** 触发器让 FTS 索引跟随主表增删改同步；外部内容表的 'delete' 命令需要原始列值。 */
function createFtsTriggers(d: Database.Database): void {
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS history_fts_ai AFTER INSERT ON history BEGIN
      INSERT INTO history_fts(rowid, source_text, translated_text, chapter_title)
      VALUES (new.id, new.source_text, new.translated_text, COALESCE(new.chapter_title, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS history_fts_ad AFTER DELETE ON history BEGIN
      INSERT INTO history_fts(history_fts, rowid, source_text, translated_text, chapter_title)
      VALUES ('delete', old.id, old.source_text, old.translated_text, COALESCE(old.chapter_title, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS history_fts_au AFTER UPDATE ON history BEGIN
      INSERT INTO history_fts(history_fts, rowid, source_text, translated_text, chapter_title)
      VALUES ('delete', old.id, old.source_text, old.translated_text, COALESCE(old.chapter_title, ''));
      INSERT INTO history_fts(rowid, source_text, translated_text, chapter_title)
      VALUES (new.id, new.source_text, new.translated_text, COALESCE(new.chapter_title, ''));
    END;
  `);
}

/**
 * 当前健康状况。会先触发一次惰性打开，使第一次调用就反映真实情况，而非一个
 * 尚未尝试的连接。
 */
export function getDatabaseStatus(): DatabaseHealth {
  getDb();
  return { ok: db !== null, error: lastError, path: dbPath() };
}

/** 可直接替换的安全访问器；数据库打开失败时返回 null。 */
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

  if (!d) {
    return { items: [], total: 0, page, pageSize };
  }

  const ftsMatch = search ? buildFtsMatch(search) : null;
  if (ftsEnabled && ftsMatch !== null) {
    // 计数与分页都必须走 MATCH，否则 COUNT 会退化成全表扫描。
    // JOIN 回主表既保证 total 与实际返回行数一致，也拿到完整列用于展示。
    // 注意：MATCH 左侧必须写真实表名；给 FTS 表起别名后 `alias MATCH ?` 会报
    // "no such column"（已在 SQLite 上实测）。
    const total = (
      d
        .prepare(
          `SELECT COUNT(*) AS n FROM history h
           JOIN history_fts ON history_fts.rowid = h.id
           WHERE history_fts MATCH ?`
        )
        .get(ftsMatch) as { n: number }
    ).n;
    const items = d
      .prepare(
        `SELECT h.* FROM history h
         JOIN history_fts ON history_fts.rowid = h.id
         WHERE history_fts MATCH ?
         ORDER BY h.timestamp DESC, h.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(ftsMatch, pageSize, (page - 1) * pageSize)
      .map(toRow);
    return { items, total, page, pageSize };
  }

  // 降级路径（FTS 不可用，或查询短于 3 字符无法被 trigram 命中）沿用原有 LIKE 实现。
  const where = search
    ? `WHERE source_text LIKE ? OR translated_text LIKE ? OR COALESCE(chapter_title, '') LIKE ?`
    : '';
  const like = `%${search}%`;
  const params = search ? [like, like, like] : [];

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

/** 所有行，最新在前——用于 CSV/JSON 导出。 */
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
  reclaimSpace(d);
  return true;
}

/** 删除早于 `days` 天的历史记录，返回删除条数（历史自动清理逻辑）。 */
export function deleteHistoryOlderThan(days: number): number {
  const d = getDb();
  if (!d) return 0;
  const cutoff = Date.now() - Math.max(1, Math.floor(days)) * 24 * 60 * 60 * 1000;
  const info = d.prepare('DELETE FROM history WHERE timestamp < ?').run(cutoff);
  if (info.changes > 0) reclaimSpace(d);
  return info.changes;
}

/**
 * 删除后回收磁盘空间。
 * 增量模式用 incremental_vacuum（无需重写整个库，代价远低于 VACUUM）；
 * 否则说明是尚未转换的旧库，把昂贵的整库 VACUUM 推迟到删除返回之后执行。
 */
function reclaimSpace(d: Database.Database): void {
  if (incrementalVacuumReady) {
    try {
      d.pragma('incremental_vacuum');
    } catch (err) {
      log.warn('[db] incremental_vacuum failed:', err);
    }
    return;
  }
  scheduleCompaction();
}

/** 延迟窗口：留出时间让 IPC 把删除结果返回给渲染进程，再开始压缩。 */
const COMPACTION_DELAY_MS = 1500;

function scheduleCompaction(): void {
  if (compactionTimer) return;
  compactionTimer = setTimeout(() => {
    compactionTimer = null;
    compactDatabase();
  }, COMPACTION_DELAY_MS);
  // 不该因为一次待执行的压缩而拖住进程退出。
  compactionTimer.unref?.();
}

/**
 * 整库压缩（VACUUM），并可完成旧库到增量模式的转换。
 *
 * 有意不在删除路径上同步调用：大库 VACUUM 会让主进程冻结数秒。
 * 可安全地在空闲时或退出前调用；重复调用是幂等的。
 */
export function compactDatabase(): void {
  const d = getDb();
  if (!d) return;
  try {
    d.pragma('wal_checkpoint(TRUNCATE)');
    if (needsAutoVacuumConvert) {
      // 与 VACUUM 同连接设置 pragma，这次 VACUUM 之后存储格式才真正切换成功。
      d.pragma('auto_vacuum = INCREMENTAL');
      needsAutoVacuumConvert = false;
    }
    d.exec('VACUUM');
    incrementalVacuumReady = true;
  } catch (err) {
    log.warn('[db] database compaction failed:', err);
  }
}

export function countHistory(): number {
  const d = getDb();
  if (!d) return 0;
  const row = d.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number };
  return row.n;
}

/** 关闭数据库连接（E2 部分：干净退出）。 */
export function closeDatabase(): void {
  // 退出时不强制跑完待执行的压缩：VACUUM 可能拖慢退出，未完成的转换下次启动会重试。
  if (compactionTimer) {
    clearTimeout(compactionTimer);
    compactionTimer = null;
  }
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