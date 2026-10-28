import { Hono, type Context } from "hono";
import { first, type Sql } from "./sql.js";

/** Agent keys start with this, so the Worker knows to check them here. */
export const KEY_PREFIX = "kim_";

/** The header the Worker sets on requests a key (not OAuth) authenticated. */
export const VIA_KEY_HEADER = "x-kim-via-key";

/** last_used_at is written at most this often, to keep reports cheap. */
const TOUCH_MS = 60_000;

const now = () => new Date().toISOString();

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 32 random bytes, base64url, behind the prefix. */
function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    KEY_PREFIX +
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  );
}

/**
 * Agent keys: long-lived, revocable credentials for places the CLI can't
 * sign in through a browser, such as a cloud session's environment. One
 * per project's cloud environment. Only a hash is stored; the key is shown
 * once. A key acts as its owner on the agent API, but can't manage keys.
 */
export function agentKeys(sql: Sql): {
  /** Under /api/sessions/kim, the CLI's OAuth resource. */
  agentRoutes: Hono;
  /**
   * Under /internal: no public route forwards there, so only the Worker
   * calling the Durable Object directly reaches them.
   */
  internalRoutes: Hono;
} {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
    );
  `);

  const view = (row: Record<string, unknown>) => ({
    id: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
  });

  /** Keys can't mint or revoke keys: a leaked one stays revocable. */
  const requireLogin = (c: Context) => {
    if (c.req.header(VIA_KEY_HEADER))
      throw new Error("Agent keys can't manage keys; use `kim login`");
  };

  const agentRoutes = new Hono();
  agentRoutes.post("/keys", async (c) => {
    requireLogin(c);
    const input = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
    };
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 100)
      throw new Error("A key needs a name of up to 100 characters");
    // Unique among live keys, so revoking by name is never ambiguous.
    if (
      first(
        sql,
        "SELECT id FROM agent_keys WHERE name=? AND revoked_at IS NULL",
        name,
      )
    )
      throw new Error(`A live key is already named "${name}"`);
    const key = newKey();
    const id = crypto.randomUUID();
    sql.all(
      "INSERT INTO agent_keys (id,name,hash,created_at) VALUES (?,?,?,?)",
      id,
      name,
      await sha256(key),
      now(),
    );
    return c.json({
      ...view(first(sql, "SELECT * FROM agent_keys WHERE id=?", id)!),
      key,
    });
  });
  agentRoutes.get("/keys", (c) => {
    requireLogin(c);
    return c.json({
      keys: sql
        .all("SELECT * FROM agent_keys ORDER BY created_at DESC")
        .map(view),
    });
  });
  agentRoutes.delete("/keys/:key", (c) => {
    requireLogin(c);
    const wanted = c.req.param("key");
    // By id, or every live key with that name.
    const rows = sql.all(
      "SELECT id FROM agent_keys WHERE (id=? OR name=?) AND revoked_at IS NULL",
      wanted,
      wanted,
    );
    if (!rows.length) throw new Error("Key not found");
    const at = now();
    for (const row of rows)
      sql.all("UPDATE agent_keys SET revoked_at=? WHERE id=?", at, row.id!);
    return c.json({
      revoked: rows.map((row) =>
        view(first(sql, "SELECT * FROM agent_keys WHERE id=?", row.id!)!),
      ),
    });
  });

  const internalRoutes = new Hono();
  internalRoutes.post("/keys/verify", async (c) => {
    const { key } = (await c.req.json().catch(() => ({}))) as {
      key?: unknown;
    };
    if (typeof key !== "string" || !key.startsWith(KEY_PREFIX))
      return c.json({ ok: false });
    const row = first(
      sql,
      "SELECT * FROM agent_keys WHERE hash=? AND revoked_at IS NULL",
      await sha256(key),
    );
    if (!row) return c.json({ ok: false });
    const used =
      row.last_used_at === null ? 0 : Date.parse(String(row.last_used_at));
    if (Date.now() - used > TOUCH_MS)
      sql.all(
        "UPDATE agent_keys SET last_used_at=? WHERE id=?",
        now(),
        row.id!,
      );
    return c.json({ ok: true, name: String(row.name) });
  });
  return { agentRoutes, internalRoutes };
}
