/**
 * 为未附带类型声明的 CommonJS 模块提供最小化的环境声明。
 * 这些模块的运行时形状很小且稳定；把垫片放在这里可避免 `noImplicitAny` 报错，
 * 又无需引入无关的 `@types` 包。
 */
declare module 'epub-gen' {
  interface EpubContentItem {
    title: string;
    data: string;
  }
  interface EpubOptions {
    title: string;
    author?: string;
    publisher?: string;
    content: EpubContentItem[];
    [key: string]: unknown;
  }
  class EpubGen {
    constructor(options: EpubOptions, outputPath: string);
    promise: Promise<void>;
  }
  export = EpubGen;
}

declare module 'better-sqlite3' {
  interface RunResult {
    lastInsertRowid: number;
    changes: number;
  }
  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  interface DatabaseInstance {
    pragma(sql: string): unknown;
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
  interface DatabaseConstructor {
    (filename: string | Buffer, options?: Record<string, unknown>): DatabaseInstance;
    new (filename: string | Buffer, options?: Record<string, unknown>): DatabaseInstance;
    Database: DatabaseInstance;
  }
  const Database: DatabaseConstructor;
  namespace Database {
    type Database = DatabaseInstance;
  }
  export = Database;
}
