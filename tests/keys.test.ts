import { afterEach, describe, expect, it } from "vitest";
import { VIA_KEY_HEADER } from "../src/server/keys.js";
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

describe("what a key may do", () => {
  it("lets a key work, but not answer, delete or manage keys", async () => {
    const { app } = harness();
    const asKey = (
      method: "GET" | "POST" | "DELETE",
      url: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        headers: { [VIA_KEY_HEADER]: "1" },
        ...(payload === undefined ? {} : { payload }),
      });
    const session = (await asKey("POST", "/api/sessions", {})).json();
    expect(session.id).toBeTruthy();
    for (const [method, url, payload] of [
      ["DELETE", `/api/sessions/${session.id}`],
      ["DELETE", `/api/sessions/${session.id}/`],
      // Answers are the user's; new routes are out until they're allowed.
      [
        "POST",
        `/api/sessions/${session.id}/questions/q1/answer`,
        { answer: "x" },
      ],
      ["POST", "/api/sessions/kim/something-new", {}],
    ] as const)
      expect(
        (await asKey(method, url, payload)).statusCode,
        `${method} ${url}`,
      ).toBe(403);
    // A signed-in CLI (no key header) still can.
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/sessions/${session.id}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("keeps live key names unique and revokes every key by name", async () => {
    const { app, sql, verify } = harness();
    const create = (name: string) =>
      app.inject({
        method: "POST",
        url: "/api/sessions/kim/keys",
        payload: { name },
      });
    const first = (await create("cloud")).json();
    expect((await create("cloud")).statusCode).toBe(400);
    // An older duplicate, as a store from before the rule could hold.
    sql.all(
      "INSERT INTO agent_keys (id,name,hash,created_at) VALUES ('old','cloud','h','2026-01-01')",
    );
    const revoked = (
      await app.inject({
        method: "DELETE",
        url: "/api/sessions/kim/keys/cloud",
      })
    ).json().revoked;
    expect(revoked).toHaveLength(2);
    expect((await verify(first.key)).ok).toBe(false);
  });

  it("lets a key do what a cloud session needs", async () => {
    const { app } = harness();
    const asKey = (method: "GET" | "POST", url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: { [VIA_KEY_HEADER]: "1" },
        ...(payload === undefined ? {} : { payload }),
      });
    const session = (await asKey("POST", "/api/sessions", {})).json();
    for (const [method, url, payload] of [
      ["POST", `/api/sessions/${session.id}/questions`, { prompt: "Which?" }],
      ["POST", `/api/sessions/${session.id}/chat`, { text: "On it." }],
      ["POST", `/api/sessions/${session.id}/stop`, {}],
      ["GET", `/api/sessions/${session.id}`],
      ["GET", "/api/sessions/projects"],
    ] as const)
      expect(
        (await asKey(method, url, payload)).statusCode,
        `${method} ${url}`,
      ).toBe(200);
  });
});
