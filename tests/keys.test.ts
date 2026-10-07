import { afterEach, describe, expect, it } from "vitest";
import { VIA_KEY_HEADER } from "../src/server/features/keys.js";
import { hubHarness } from "./helpers/harness.js";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

function harness() {
  const result = hubHarness();
  closers.push(() => result.sql.close());
  const verify = async (key: string) =>
    (
      await result.app.inject({
        method: "POST",
        url: "/internal/keys/verify",
        payload: { key },
      })
    ).json() as { ok: boolean; name?: string };
  return { ...result, verify };
}

describe("agent keys", () => {
  it("shows a key once, verifies it, and stops it on revoke", async () => {
    const { app, sql, verify } = harness();
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/sessions/kim/keys",
        payload: { name: "frockbot cloud" },
      })
    ).json();
    expect(created.key).toMatch(/^kim_[A-Za-z0-9_-]{43}$/);
    // Only the hash is stored.
    expect(JSON.stringify(sql.all("SELECT * FROM agent_keys"))).not.toContain(
      created.key,
    );
    expect(await verify(created.key)).toEqual({
      ok: true,
      name: "frockbot cloud",
    });
    expect((await verify("kim_wrong")).ok).toBe(false);
    const listed = (
      await app.inject({ method: "GET", url: "/api/sessions/kim/keys" })
    ).json().keys;
    expect(listed[0]).toMatchObject({ name: "frockbot cloud" });
    expect(listed[0].lastUsedAt).not.toBeNull();
    expect(JSON.stringify(listed)).not.toContain(created.key);

    await app.inject({
      method: "DELETE",
      url: "/api/sessions/kim/keys/frockbot%20cloud",
    });
    expect((await verify(created.key)).ok).toBe(false);
  });

  it("refuses to let a key manage keys", async () => {
    const { app } = harness();
    for (const [method, url] of [
      ["POST", "/api/sessions/kim/keys"],
      ["GET", "/api/sessions/kim/keys"],
      ["DELETE", "/api/sessions/kim/keys/any"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        ...(method === "POST" ? { payload: { name: "minted by a key" } } : {}),
        headers: { [VIA_KEY_HEADER]: "1" },
      });
      expect(response.statusCode).toBe(403);
    }
  });
});
