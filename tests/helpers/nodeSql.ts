import { DatabaseSync } from "node:sqlite";
import type { Row, Sql } from "../../src/server/sql.js";

/** node:sqlite as the store's Sql, standing in for a Durable Object's storage. */
export function nodeSql(path = ":memory:"): Sql & { close(): void } {
  const db = new DatabaseSync(path);
  return {
    // The hub's push check runs a moment after questions arrive, often after
    // a test has closed the database: it then finds nothing.
    all: (query, ...params) =>
      db.isOpen ? (db.prepare(query).all(...params) as Row[]) : [],
    exec: (script) => db.exec(script),
    transaction(fn) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}
