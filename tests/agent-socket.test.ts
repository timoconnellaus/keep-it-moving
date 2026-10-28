import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyMayCall } from "../src/server/hub.js";
import { hubHarness } from "./helpers/harness.js";

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length) cleanups.pop()?.();
});

/** An interview with two open questions, and a way to open agent sockets on it. */
function setup() {
  const harness = hubHarness();
  cleanups.push(() => harness.sql.close());
  const { store, agents, app } = harness;
  const session = store.createSession("", { title: "Plan" });
  const [one, two] = store.addQuestions(session.id, [
    { type: "text", prompt: "One?" },
    { type: "text", prompt: "Two?" },
  ]);
  const open = async (query: string, id = session.id) => {
    const response = await app.fetch(
      new Request(`https://hub/api/sessions/${id}/socket?${query}`, {
        headers: { upgrade: "websocket" },
      }),
    );
    return { response, socket: agents.all.at(-1)! };
  };
  const answer = (questionId: string, text: string) =>
    store.answerQuestion(session.id, questionId, { answer: text });
  const browser = async () =>
    (await app
      .inject({
        method: "GET",
        url: `/api/browser/${session.token}/session`,
      })
      .then((response) => response.json())) as { agentWatching: boolean };
  return { ...harness, session, one: one!, two: two!, open, answer, browser };
}

describe("agent socket wait", () => {
  it("delivers a batch once and marks it delivered", async () => {
    const { open, answer, one, two, store, session } = setup();
    const { response, socket } = await open("mode=wait&idle=0");
    expect(response.status).toBe(200);
    // Nothing the user did yet: the socket just waits.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.sent).toEqual([]);
    answer(one.id, "Yes");
    answer(two.id, "No");
    await vi.advanceTimersByTimeAsync(1_000);
    const [message] = socket.messages();
    expect(message.type).toBe("batch");
    expect(
      message.batch.answers.map((item: { answer: string }) => item.answer),
    ).toEqual(["Yes", "No"]);
    expect(socket.closed?.code).toBe(1000);
    expect(store.undeliveredEvents(session.id)).toEqual([]);
    expect(
      store.getSession(session.id, "").questions[0]!.answer?.delivered,
    ).toBe(true);
    // A second wait does not get the same answers again.
    const again = await open("mode=wait&idle=0&timeout=1000");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(again.socket.messages()[0].batch.answers).toEqual([]);
  });

  it("waits for the user to pause while questions are open", async () => {
    const { open, answer, one, agents } = setup();
    const { socket } = await open("mode=wait&idle=60000");
    answer(one.id, "Yes");
    await vi.advanceTimersByTimeAsync(0);
    // The alarm, not a held request, brings the batch.
    expect(agents.state.alarmAt).toBe(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(socket.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.messages()[0].batch.openQuestions).toBe(1);
    expect(agents.state.alarmAt).toBeNull();
  });

  it("settles quickly once nothing is left open", async () => {
    const { open, answer, one, two } = setup();
    const { socket } = await open("mode=wait&idle=60000");
    answer(one.id, "Yes");
    answer(two.id, "No");
    await vi.advanceTimersByTimeAsync(800);
    expect(socket.messages()[0].batch.openQuestions).toBe(0);
  });

  it("wakes for a chat message", async () => {
    const { open, store, session } = setup();
    const { socket } = await open("mode=wait&idle=60000");
    store.addChatMessage(session.id, "user", { text: "Why two?" });
    await vi.advanceTimersByTimeAsync(800);
    expect(socket.messages()[0].batch.messages).toEqual([
      expect.objectContaining({ text: "Why two?" }),
    ]);
  });

  it("returns what it has at the timeout", async () => {
    const { open } = setup();
    const { socket } = await open("mode=wait&timeout=30000");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.messages()[0]).toMatchObject({
      type: "batch",
      batch: { answers: [], openQuestions: 2 },
    });
  });

  it("hands a batch already due to a socket that reconnects", async () => {
    const { open, answer, one, two } = setup();
    const first = await open("mode=wait&idle=0");
    first.socket.disconnect();
    answer(one.id, "Yes");
    answer(two.id, "No");
    await vi.advanceTimersByTimeAsync(1_000);
    const { socket } = await open("mode=wait&idle=0");
    expect(socket.messages()[0].batch.answers).toHaveLength(2);
  });
});

describe("agent socket watchers", () => {
  it("lets the newest watcher replace the old one", async () => {
    const { open, answer, one, two } = setup();
    const old = await open("mode=wait&idle=0");
    const fresh = await open("mode=wait&idle=0");
    expect(old.socket.messages()).toEqual([
      { type: "replaced", message: expect.stringMatching(/newer watcher/) },
    ]);
    expect(old.socket.closed?.code).toBe(4409);
    answer(one.id, "Yes");
    answer(two.id, "No");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fresh.socket.messages()[0].batch.answers).toHaveLength(2);
  });

  it("replaces an older CLI's HTTP wait, and is replaced by one", async () => {
    const { open, app, session } = setup();
    const stale = app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/wait?idle=0&timeout=60000`,
    });
    await vi.advanceTimersByTimeAsync(0);
    const { socket } = await open("mode=wait");
    expect((await stale).statusCode).toBe(409);
    const newer = app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/wait?idle=0&timeout=10`,
    });
    await vi.advanceTimersByTimeAsync(20);
    await newer;
    expect(socket.closed?.code).toBe(4409);
  });

  it("shows the agent as watching while a socket is open", async () => {
    const { open, browser } = setup();
    expect((await browser()).agentWatching).toBe(false);
    const { socket } = await open("mode=wait");
    expect((await browser()).agentWatching).toBe(true);
    socket.disconnect();
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await browser()).agentWatching).toBe(false);
  });

  it("streams events to attach and marks them delivered", async () => {
    const { open, answer, one, store, session } = setup();
    const { socket } = await open("mode=attach");
    expect(socket.messages()[0]).toMatchObject({
      type: "snapshot",
      events: expect.any(Array),
    });
    answer(one.id, "Yes");
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.messages()[1]).toMatchObject({
      type: "event",
      event: { type: "answer.submitted" },
    });
    expect(store.undeliveredEvents(session.id)).toEqual([]);
    expect(socket.closed).toBeNull();
  });

  it("gives events next the next event, or none at its timeout", async () => {
    const { open, answer, one, session, store } = setup();
    store.markDelivered(session.id, Number.MAX_SAFE_INTEGER);
    const quiet = await open("mode=next&timeout=1000");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(quiet.socket.messages()[0].result.events).toEqual([]);
    const { socket } = await open("mode=next&timeout=10000");
    answer(one.id, "Yes");
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.messages()[0].result.events).toEqual([
      expect.objectContaining({ type: "answer.submitted" }),
    ]);
  });

  it("ends a socket when its interview is deleted", async () => {
    const { open, app, session } = setup();
    const { socket } = await open("mode=wait");
    await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}` });
    expect(socket.closed?.code).toBe(4404);
  });

  it("refuses an unknown interview or a plain request before upgrading", async () => {
    const { open, app, session } = setup();
    expect((await open("mode=wait", "missing")).response.status).toBe(404);
    const plain = await app.fetch(
      new Request(`https://hub/api/sessions/${session.id}/socket`),
    );
    expect(plain.status).toBe(426);
  });

  it("is open to agent keys", () => {
    expect(keyMayCall("GET", "/api/sessions/abc/socket")).toBe(true);
  });
});
