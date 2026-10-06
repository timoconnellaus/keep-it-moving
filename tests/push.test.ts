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
    store.addPushSubscription("https://push.example/phone");
    const session = store.createSession("", {});
    store.addQuestions(session.id, [{ prompt: "One?" }, { prompt: "Two?" }]);
    await settle();
    expect(sent).toEqual(["https://push.example/phone"]);

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
    store.addPushSubscription("https://push.example/old-phone");
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
      payload: { endpoint: "https://push.example/phone" },
    });
    const refused = await app.inject({
      method: "POST",
      url: "/api/browser/push/subscribe",
      payload: { endpoint: "javascript:alert(1)" },
    });
    expect(refused.statusCode).toBe(400);
    const test = await app.inject({
      method: "POST",
      url: "/api/browser/push/test",
    });
    expect(test.json()).toEqual({ ok: true, devices: 1 });
    expect(sent).toEqual(["https://push.example/phone"]);
    sql.close();
  });
});
