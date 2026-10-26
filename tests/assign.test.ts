import { afterEach, describe, expect, it, vi } from "vitest";
import { RESPONDENT_HEADER } from "../src/server/hub.js";
import { hubHarness } from "./helpers/harness.js";

afterEach(() => vi.useRealTimers());

/** An interview with two questions, assigned to Bob, with push recorded. */
function harness() {
  const sent: string[] = [];
  const result = hubHarness({
    push: {
      publicKey: "public",
      send: async (endpoint) => {
        sent.push(endpoint);
        return 201;
      },
    },
  });
  const { store } = result;
  store.addPushSubscription("https://fcm.googleapis.com/fcm/send/phone");
  const session = store.createSession("", { title: "Venue survey" });
  const questions = store.addQuestions(session.id, [
    { prompt: "Which room?" },
    { prompt: "When?" },
  ]);
  store.assignSession(session.id, "bob@example.com", "Ann");
  const asBob = (method: string, url: string, payload?: unknown) =>
    result.app.inject({
      method,
      url,
      payload,
      headers: { [RESPONDENT_HEADER]: "bob@example.com" },
    });
  return { ...result, sent, session, questions, asBob };
}

describe("an assignee in the owner's hub", () => {
  it("reaches only the interview's own routes", async () => {
    const { app, asBob, session, questions, store, sql } = harness();
    const other = store.createSession("", { title: "Private" });
    const base = `/api/browser/${session.token}`;
    expect((await asBob("GET", `${base}/session`)).statusCode).toBe(200);
    expect(
      (
        await asBob("POST", `${base}/questions/${questions[0]!.id}/answer`, {
          answer: "The big one",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await asBob("POST", `${base}/chat`, { text: "Parking?" })).statusCode,
    ).toBe(200);
    for (const [method, url] of [
      ["GET", "/api/browser/overview"],
      ["POST", "/api/browser/push/subscribe"],
      ["POST", `${base}/assign`],
      ["GET", `/api/browser/${other.token}/session`],
      ["GET", "/api/sessions"],
      ["GET", `/api/sessions/${session.id}`],
      ["GET", "/api/sessions/kim/keys"],
      ["POST", "/internal/keys/verify"],
    ] as const)
      expect(
        (await asBob(method, url, method === "GET" ? undefined : {}))
          .statusCode,
        url,
      ).toBe(403);
    // The same routes, from someone it isn't assigned to.
    const carol = await app.inject({
      method: "GET",
      url: `${base}/session`,
      headers: { [RESPONDENT_HEADER]: "carol@example.com" },
    });
    expect(carol.statusCode).toBe(403);
    sql.close();
  });

  it("sees the interview without the owner's workspace around it", async () => {
    const { asBob, session, sql } = harness();
    const view = (
      await asBob("GET", `/api/browser/${session.token}/session`)
    ).json();
    expect(view).toMatchObject({
      respondent: true,
      project: null,
      assignedBy: "Ann",
    });
    expect(view.origin.branch).toBeNull();
    sql.close();
  });

  it("attributes answers and chat to the assignee", async () => {
    const { asBob, session, questions, store, sql } = harness();
    await asBob(
      "POST",
      `/api/browser/${session.token}/questions/${questions[0]!.id}/answer`,
      { answer: "The big one" },
    );
    await asBob("POST", `/api/browser/${session.token}/chat`, {
      text: "Parking?",
    });
    const view = store.getSession(session.id, "");
    expect(view.questions[0]!.answer?.answeredBy).toBe("bob@example.com");
    expect(view.chat[0]!.authorEmail).toBe("bob@example.com");
    // The owner's own answer is theirs.
    store.answerQuestion(session.id, questions[1]!.id, { answer: "Friday" });
    expect(
      store.getSession(session.id, "").questions[1]!.answer?.answeredBy,
    ).toBeNull();
    sql.close();
  });
});

describe("the owner of an assigned interview", () => {
  it("isn't pushed for its questions, but is once per burst of answers", async () => {
    vi.useFakeTimers();
    const { asBob, sent, session, questions, store, sql } = harness();
    store.addQuestions(session.id, [{ prompt: "Budget?" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);
    for (const question of questions)
      await asBob(
        "POST",
        `/api/browser/${session.token}/questions/${question.id}/answer`,
        { answer: "Yes" },
      );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1);
    sql.close();
  });

  it("sees it as waiting on the assignee, not on them", () => {
    const { session, store, sql } = harness();
    expect(store.summaries()[0]).toMatchObject({
      id: session.id,
      open: 0,
      assignee: "bob@example.com",
      total: 2,
    });
    expect(store.openQuestions(session.id)).toBe(0);
    store.assignSession(session.id, null, null);
    expect(store.openQuestions(session.id)).toBe(2);
    sql.close();
  });

  it("refuses an address that isn't one", () => {
    const { session, store, sql } = harness();
    expect(() => store.assignSession(session.id, "bob", null)).toThrow(
      /not an email/,
    );
    sql.close();
  });
});
