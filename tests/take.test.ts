import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOOK_LIVE_MS, keyMayCall } from "../src/server/hub.js";
import { PLAN_HEADER } from "../src/server/plans.js";
import { hubHarness } from "./helpers/harness.js";

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length) cleanups.pop()?.();
});

/** A hub with interviews of two open questions each, as a user on `plan`. */
function setup(plan: "free" | "pro" = "free", count = 1) {
  const harness = hubHarness();
  cleanups.push(() => harness.sql.close());
  const { store, app, agents } = harness;
  const sessions = Array.from({ length: count }, (_, index) => {
    const session = store.createSession("", {
      title: `Interview ${index + 1}`,
    });
    const questions = store.addQuestions(session.id, [
      { type: "text", prompt: "One?" },
      { type: "text", prompt: "Two?" },
    ]);
    return { ...session, questions };
  });
  const headers = { [PLAN_HEADER]: plan };
  const take = (id = sessions[0]!.id) =>
    app.inject({ method: "POST", url: `/api/sessions/${id}/take`, headers });
  const watch = (id = sessions[0]!.id) =>
    app.fetch(
      new Request(`https://hub/api/sessions/${id}/socket?mode=wait&idle=0`, {
        headers: { ...headers, upgrade: "websocket" },
      }),
    );
  const answer = (index: number, text: string, session = sessions[0]!) =>
    store.answerQuestion(session.id, session.questions[index]!.id, {
      answer: text,
    });
  return { ...harness, store, agents, sessions, take, watch, answer };
}

describe("take", () => {
  it("returns the batch a socket would get, once, and an empty one after", async () => {
    const { take, answer } = setup();
    const before = await take();
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      type: "batch",
      batch: { events: [], answers: [], openQuestions: 2, status: "active" },
    });
    answer(0, "Yes");
    const first = (await take()).json();
    expect(first.batch.answers).toEqual([
      expect.objectContaining({ number: 1, prompt: "One?", answer: "Yes" }),
    ]);
    expect(first.batch.events.length).toBeGreaterThan(0);
    expect(first.batch.openQuestions).toBe(1);
    expect((await take()).json().batch.events).toEqual([]);
  });

  it("brings the user's chat messages too, once they've settled like a socket's", async () => {
    const { take, store, sessions } = setup();
    store.addChatMessage(sessions[0]!.id, "user", { text: "Why two?" });
    expect((await take()).json().batch.messages).toEqual([]);
    vi.advanceTimersByTime(1_000);
    const { batch } = (await take()).json();
    expect(batch.messages).toEqual([
      expect.objectContaining({ text: "Why two?" }),
    ]);
  });

  it("leaves the batch to an agent waiting on the interview, so nothing arrives twice", async () => {
    const { take, watch, answer, agents } = setup();
    await watch();
    answer(0, "Yes");
    answer(1, "No");
    const taken = (await take()).json();
    expect(taken).toMatchObject({ watched: true, batch: { events: [] } });
    await vi.advanceTimersByTimeAsync(1_000);
    const [message] = agents.all[0]!.messages();
    expect(
      message.batch.answers.map((item: { answer: string }) => item.answer),
    ).toEqual(["Yes", "No"]);
    // Delivered once: the socket had it, so the next take has nothing.
    expect((await take()).json().batch.events).toEqual([]);
  });

  it("leaves nothing for a socket that starts waiting after a take", async () => {
    const { take, watch, answer, agents } = setup();
    answer(0, "Yes");
    expect((await take()).json().batch.answers).toHaveLength(1);
    await watch();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(agents.all[0]!.sent).toEqual([]);
    answer(1, "No");
    await vi.advanceTimersByTimeAsync(1_000);
    const [message] = agents.all[0]!.messages();
    expect(
      message.batch.answers.map((item: { answer: string }) => item.answer),
    ).toEqual(["No"]);
  });

  it("says the interview is gone with a 404", async () => {
    const { take, store, sessions } = setup();
    store.deleteSession(sessions[0]!.id);
    expect((await take()).statusCode).toBe(404);
  });

  it("is open to agent keys", () => {
    expect(keyMayCall("POST", "/api/sessions/abc/take")).toBe(true);
    expect(keyMayCall("GET", "/api/sessions/abc/take")).toBe(false);
  });
});

describe("the Free plan's live interviews, with hooks", () => {
  it("counts an interview whose hook asked lately, and refuses a fourth take like a socket", async () => {
    const { sessions, take, watch } = setup("free", 5);
    for (const session of sessions.slice(0, 3))
      expect((await take(session.id)).statusCode).toBe(200);
    const refused = await take(sessions[3]!.id);
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({
      code: "plan_limit",
      feature: "live",
      limit: 3,
    });
    expect(
      refused.json().live.map((live: { title: string }) => live.title),
    ).toEqual(["Interview 1", "Interview 2", "Interview 3"]);
    // A socket is refused the same way, and a live interview's hook isn't.
    expect((await watch(sessions[3]!.id)).status).toBe(402);
    expect((await take(sessions[0]!.id)).statusCode).toBe(200);
  });

  it("stops counting one when its questions are answered, it stops, or the hook goes quiet", async () => {
    const { sessions, take, answer, store } = setup("free", 5);
    for (const session of sessions.slice(0, 3)) await take(session.id);
    expect((await take(sessions[3]!.id)).statusCode).toBe(402);
    answer(0, "Yes", sessions[0]);
    answer(1, "No", sessions[0]);
    expect((await take(sessions[3]!.id)).statusCode).toBe(200);
    store.setSessionStatus(sessions[1]!.id, "stopped");
    expect((await take(sessions[4]!.id)).statusCode).toBe(200);
    // Interviews 3, 4 and 5 are live; a quarter hour later none are.
    expect((await take(sessions[1]!.id)).statusCode).toBe(402);
    vi.advanceTimersByTime(HOOK_LIVE_MS + 1_000);
    store.setSessionStatus(sessions[1]!.id, "active");
    expect((await take(sessions[1]!.id)).statusCode).toBe(200);
  });

  it("has no limit on Pro", async () => {
    const { sessions, take } = setup("pro", 5);
    for (const session of sessions)
      expect((await take(session.id)).statusCode).toBe(200);
  });
});

describe("read receipts and presence", () => {
  const page = async (
    harness: ReturnType<typeof setup>,
    token = harness.sessions[0]!.token,
  ) =>
    (
      await harness.app.inject({
        method: "GET",
        url: `/api/browser/${token}/session`,
      })
    ).json() as import("../src/shared/schema.js").SessionView;

  it("stamps when a hook took each answer and message, and clears it on revision", async () => {
    const harness = setup();
    const { take, answer, store, sessions } = harness;
    answer(0, "Yes");
    store.addChatMessage(sessions[0]!.id, "user", { text: "Why?" });
    expect((await page(harness)).questions[0]!.answer!.deliveredAt).toBeNull();
    const at = new Date(Date.now() + 60_000).toISOString();
    vi.setSystemTime(Date.parse(at));
    await take();
    const read = await page(harness);
    expect(read.questions[0]!.answer!.deliveredAt).toBe(at);
    expect(read.chat[0]!.deliveredAt).toBe(at);
    answer(0, "No");
    expect((await page(harness)).questions[0]!.answer!.deliveredAt).toBeNull();
  });

  it("shows when a hook last asked, and forgets it when the agent's session ends", async () => {
    const harness = setup();
    const { take, app, sessions } = harness;
    expect((await page(harness)).agentSeenAt ?? null).toBeNull();
    await take();
    expect((await page(harness)).agentSeenAt).toEqual(expect.any(String));
    const away = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessions[0]!.id}/away`,
    });
    expect(away.statusCode).toBe(200);
    expect(await page(harness)).toMatchObject({
      agentSeenAt: null,
      agentWatching: false,
    });
  });
});
