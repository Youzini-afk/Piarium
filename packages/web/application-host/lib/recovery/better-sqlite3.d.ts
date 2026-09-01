declare module 'better-sqlite3' {
  interface DatabaseOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
  }

  interface PragmaOptions {
    simple?: boolean;
  }

  interface Statement {
    run(...params: unknown[]): RunResult;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown | undefined;
    iterate(...params: unknown[]): Iterable<unknown>;
  }

  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export default class Database {
    constructor(filename: string, options?: DatabaseOptions);
    pragma(source: string, options?: PragmaOptions): unknown;
    prepare(source: string): Statement;
    exec(source: string): void;
    transaction<T extends (...args: never[]) => unknown>(fn: T): T;
    close(): void;
  }
}
