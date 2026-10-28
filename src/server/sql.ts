/** A value SQLite can bind on both Durable Objects and node:sqlite. */
export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/**
 * The synchronous SQLite surface the store needs. A Durable Object's
 * storage.sql backs it in production; tests use node:sqlite.
 */
export interface Sql {
  all(query: string, ...params: SqlValue[]): Row[];
  /** Runs a script of statements without parameters. */
  exec(script: string): void;
  /** Runs fn atomically; a throw rolls back every write it made. */
  transaction<T>(fn: () => T): T;
}

export const first = (sql: Sql, query: string, ...params: SqlValue[]) =>
  sql.all(query, ...params)[0];

/** A Durable Object's SQLite storage as an Sql. */
export function durableObjectSql(storage: DurableObjectStorage): Sql {
  return {
    all: (query, ...params) =>
      storage.sql.exec(query, ...params).toArray() as Row[],
    exec: (script) => void storage.sql.exec(script),
    transaction: (fn) => storage.transactionSync(fn),
  };
}
