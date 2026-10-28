import { afterEach, describe, expect, it, vi } from "vitest";
import { hubHarness } from "./helpers/harness.js";

afterEach(() => vi.useRealTimers());

function harness(status = 201) {
  const sent: string[] = [];
  const result = hubHarness({
    push: {
      publicKey: "public",
      send: async (endpoint) => {
        sent.push(endpoint);
        return status;
      },
    },
  });
  return { ...result, sent };
}

/** Lets the hub's settle timer fire and its sends finish. */
async function settle() {
  await vi.advanceTimersByTimeAsync(2_000);
}

describe("push notifications", () => {
  it("notifies once when an interview with nothing open gains questions", async () => {
    vi.useFakeTimers();
    const { store, sent, sql } = harness();
    store.addPushSubscription("https://fcm.googleapis.com/fcm/send/phone");
    const session = store.createSession("", {});
    store.addQuestions(session.id, [{ prompt: "One?" }, { prompt: "Two?" }]);
    await settle();
    expect(sent).toEqual(["https://fcm.googleapis.com/fcm/send/phone"]);

    // More questions while some are still open: the user already knows.
    store.addQuestions(session.id, [{ prompt: "Three?" }]);
    await settle();
    expect(sent).toHaveLength(1);

    // Once everything is answered, the next question notifies again.
    const open = store.getSession(session.id, "").questions;
    for (const question of open)
      store.answerQuestion(session.id, question.id, { answer: "Yes" });
    store.addQuestions(session.id, [{ prompt: "Four?" }]);
    await settle();
    expect(sent).toHaveLength(2);
    sql.close();
  });

  it("forgets a device whose push service says it is gone", async () => {
    vi.useFakeTimers();
    const { store, sql } = harness(410);
    store.addPushSubscription("https://fcm.googleapis.com/fcm/send/old-phone");
    const session = store.createSession("", {});
    store.addQuestions(session.id, [{ prompt: "One?" }]);
    await settle();
    expect(store.pushSubscriptions()).toEqual([]);
    sql.close();
  });

  it("subscribes a device and sends a test from the page", async () => {
    const { app, sent, sql } = harness();
    expect(
      (
        await app.inject({ method: "GET", url: "/api/browser/push/key" })
      ).json(),
    ).toEqual({ publicKey: "public" });
    await app.inject({
      method: "POST",
      url: "/api/browser/push/subscribe",
      payload: { endpoint: "https://fcm.googleapis.com/fcm/send/phone" },
    });
    const refused = await app.inject({
      method: "POST",
      url: "/api/browser/push/subscribe",
      payload: { endpoint: "javascript:alert(1)" },
    });
    expect(refused.statusCode).toBe(400);
    const elsewhere = await app.inject({
      method: "POST",
      url: "/api/browser/push/subscribe",
      payload: { endpoint: "https://attacker.example/collect" },
    });
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json().error).toContain("not a known push service");
    const test = await app.inject({
      method: "POST",
      url: "/api/browser/push/test",
    });
    expect(test.json()).toEqual({ ok: true, devices: 1 });
    expect(sent).toEqual(["https://fcm.googleapis.com/fcm/send/phone"]);
    sql.close();
  });
});

describe("cross-site requests", () => {
  it("refuses browser writes from another site but allows its own pages and the CLI", async () => {
    const { app, store, sql } = harness();
    const session = store.createSession("", {});
    const write = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: `/api/browser/${session.token}/stage/visibility`,
        payload: { visible: true },
        headers,
      });
    expect((await write({ "sec-fetch-site": "cross-site" })).statusCode).toBe(
      403,
    );
    expect((await write({ origin: "https://evil.example" })).statusCode).toBe(
      403,
    );
    expect((await write({ "sec-fetch-site": "same-origin" })).statusCode).toBe(
      200,
    );
    expect((await write({})).statusCode).toBe(200);
    // Reads stay open: a cross-site page can't read the response anyway.
    const read = await app.inject({
      method: "GET",
      url: "/api/browser/overview",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(read.statusCode).toBe(200);
    sql.close();
  });
});
