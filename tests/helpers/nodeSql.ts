import { DatabaseSync } from "node:sqlite";
import type { Row, Sql } from "../../src/server/sql.js";

/** node:sqlite as the store's Sql, standing in for a Durable Object's storage. */
export function nodeSql(path = ":memory:"): Sql & { close(): void } {
  const db = new DatabaseSync(path);
  return {
    all: (query, ...params) => db.prepare(query).all(...params) as Row[],
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
