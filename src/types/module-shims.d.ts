/**
 * Minimal ambient declarations for CommonJS modules that ship no typings.
 * The runtime shapes are small and stable; keeping the shims here avoids
 * `noImplicitAny` failures without pulling in unrelated `@types` packages.
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
