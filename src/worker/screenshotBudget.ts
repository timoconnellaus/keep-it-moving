import { DurableObject } from "cloudflare:workers";
import { first, durableObjectSql, type Sql } from "../server/sql.js";
import type { Env } from "./env.js";

/**
 * How much of Cloudflare's browser time screenshots may use. Workers Paid
 * includes 10 browser hours a month, billed per second, then charges by the
 * hour; screenshots stop at 9, counted over the last 32 days rather than the
 * calendar month, so no billing cycle, wherever it starts, sees more.
 */
export const MONTH_MS = 9 * 60 * 60_000;
const WINDOW_DAYS = 32;
/** Renders at once, across everyone. */
export const MAX_RENDERING = 3;
/** Renders (cache misses) one person may start in a UTC day. */
export const DAILY_RENDERS = 100;
/**
 * A render that never reported back (its Worker died) is counted as
 * having used this long, and stops holding a place.
 */
export const LEASE_MS = 2 * 60_000;

export type Refused = "paused" | "daily" | "busy";
export type Begun =
  { ok: true; lease: string } | { ok: false; refused: Refused };

const day = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * The ledger, over SQLite: browser time used per UTC day, renders per person
 * per day, and the renders running now. One Durable Object holds it, so
 * every count is exact.
 */
export function screenshotLedger(sql: Sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS screenshot_usage (day TEXT PRIMARY KEY, ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS screenshot_renders (day TEXT NOT NULL, email TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, email));
    CREATE TABLE IF NOT EXISTS screenshot_leases (id TEXT PRIMARY KEY, started INTEGER NOT NULL);
  `);
  const charge = (ms: number, now: number) =>
    sql.all(
      `INSERT INTO screenshot_usage (day, ms) VALUES (?, ?)
       ON CONFLICT (day) DO UPDATE SET ms = ms + excluded.ms`,
      day(now),
      Math.max(0, Math.round(ms)),
    );
  const used = (now: number) =>
    Number(
      first(
        sql,
        "SELECT COALESCE(SUM(ms), 0) AS ms FROM screenshot_usage WHERE day > ?",
        day(now - WINDOW_DAYS * 86_400_000),
      )?.ms ?? 0,
    );
  return {
    /** Takes a place for a render, or says why not. */
    begin(email: string, now = Date.now()): Begun {
      return sql.transaction(() => {
        const stale = sql.all(
          "DELETE FROM screenshot_leases WHERE started <= ? RETURNING id",
          now - LEASE_MS,
        ).length;
        if (stale) charge(stale * LEASE_MS, now);
        sql.all(
          "DELETE FROM screenshot_usage WHERE day <= ?",
          day(now - 40 * 86_400_000),
        );
        sql.all("DELETE FROM screenshot_renders WHERE day <> ?", day(now));
        if (used(now) >= MONTH_MS) return { ok: false, refused: "paused" };
        const running = Number(
          first(sql, "SELECT COUNT(*) AS n FROM screenshot_leases")?.n ?? 0,
        );
        if (running >= MAX_RENDERING) return { ok: false, refused: "busy" };
        const address = email.trim().toLowerCase();
        const renders = Number(
          first(
            sql,
            "SELECT count FROM screenshot_renders WHERE day = ? AND email = ?",
            day(now),
            address,
          )?.count ?? 0,
        );
        if (renders >= DAILY_RENDERS) return { ok: false, refused: "daily" };
        sql.all(
          `INSERT INTO screenshot_renders (day, email, count) VALUES (?, ?, 1)
           ON CONFLICT (day, email) DO UPDATE SET count = count + 1`,
          day(now),
          address,
        );
        const lease = crypto.randomUUID();
        sql.all(
          "INSERT INTO screenshot_leases (id, started) VALUES (?, ?)",
          lease,
          now,
        );
        return { ok: true, lease };
      });
    },
    /**
     * A render finished, having had a browser for `ms`. A lease already
     * expired was charged then.
     */
    end(lease: string, ms: number, now = Date.now()) {
      sql.transaction(() => {
        const held = sql.all(
          "DELETE FROM screenshot_leases WHERE id = ? RETURNING id",
          lease,
        );
        if (held.length) charge(ms, now);
      });
    },
    /** Browser time counted in the window, in ms. */
    used,
  };
}

export type ScreenshotLedger = ReturnType<typeof screenshotLedger>;

/** The one ledger, as a Durable Object: `idFromName("ledger")`. */
export class ScreenshotBudget extends DurableObject<Env> {
  private readonly ledger: ScreenshotLedger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = screenshotLedger(durableObjectSql(ctx.storage));
  }

  begin(email: string): Begun {
    return this.ledger.begin(email);
  }

  end(lease: string, ms: number) {
    this.ledger.end(lease, ms);
  }
}
