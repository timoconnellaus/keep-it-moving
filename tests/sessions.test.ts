import { afterEach, describe, expect, it, vi } from "vitest";
import { hubHarness } from "./helpers/harness.js";

const closers: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  closers.splice(0).forEach((close) => close());
});

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
  closers.push(() => result.sql.close());
  const report = async (payload: Record<string, unknown>) => {
    const response = await result.app.inject({
      method: "POST",
      url: "/api/sessions/kim/report",
      payload,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const inbox = async () =>
    (
      await result.app.inject({ method: "GET", url: "/api/browser/kim/inbox" })
    ).json().items as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { ...result, sent, report, inbox };
}

describe("agent session reports", () => {
  it("upserts by id, keeps omitted fields and restarts status_since on a status change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    const { report, app } = harness();
    const created = await report({
      id: "agent-1",
      projectKey: "github.com/o/frockbot",
      defaultTitle: "Fix the booking flow",
      status: "running",
      branch: "claude/booking",
      machine: "tim-mbp",
      location: "local",
    });
    expect(created).toMatchObject({
      title: "Fix the booking flow",
      status: "running",
      statusSince: "2026-10-07T10:00:00.000Z",
      branch: "claude/booking",
    });

    vi.setSystemTime(new Date("2026-10-07T10:05:00Z"));
    // A later prompt doesn't retitle it; the same status keeps its time.
    const same = await report({
      id: "agent-1",
      defaultTitle: "Another prompt",
      status: "running",
    });
    expect(same.title).toBe("Fix the booking flow");
    expect(same.statusSince).toBe("2026-10-07T10:00:00.000Z");
    expect(same.updatedAt).toBe("2026-10-07T10:05:00.000Z");
    expect(same.branch).toBe("claude/booking");

    vi.setSystemTime(new Date("2026-10-07T10:09:00Z"));
    const idle = await report({
      id: "agent-1",
      status: "idle",
      brief: "Done.",
    });
    expect(idle).toMatchObject({
      status: "idle",
      statusSince: "2026-10-07T10:09:00.000Z",
      brief: "Done.",
      projectId: created.projectId,
    });

    const listed = (
      await app.inject({
        method: "GET",
        url: `/api/browser/kim/projects/${created.projectId}/sessions`,
      })
    ).json();
    expect(listed.sessions.map((s: { id: string }) => s.id)).toEqual([
      "agent-1",
    ]);
    const projects = (
      await app.inject({ method: "GET", url: "/api/browser/kim/projects" })
    ).json().projects;
    expect(projects[0]).toMatchObject({
      name: "Frockbot",
      stats: { running: 0, needsYou: 1 },
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/browser/kim/sessions/nope",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses a report without an id or with an unknown status", async () => {
    const { app } = harness();
    for (const payload of [{ status: "running" }, { id: "a", status: "lost" }])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/sessions/kim/report",
            payload,
          })
        ).statusCode,
      ).toBe(400);
  });
});

describe("sessions in the inbox", () => {
  it("lists requests and waiting sessions, without a duplicate for a session with an open request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let minute = 0;
    const tick = () =>
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 7, 10, minute++)));
    tick();
    const { report, inbox, store } = harness();
    await report({
      id: "asker",
      projectKey: "github.com/o/frockbot",
      title: "D1 migration",
      status: "needs_you",
      brief: "The migration is ready; it needs a backup decision.",
    });
    tick();
    await report({
      id: "waiting",
      title: "Intake form",
      status: "needs_you",
      message: "Claude needs your permission to use Bash",
    });
    tick();
    await report({ id: "finished", title: "Refactor", status: "idle" });
    await report({ id: "gone", title: "Old", status: "done" });
    tick();
    const request = store.createSession("", {
      title: "Run the migration?",
      origin: { agentSessionId: "asker" },
    });
    store.addQuestions(request.id, [
      { prompt: "Back up first?" },
      { prompt: "When?" },
    ]);
    // An interview with no agent session briefs from its first question.
    tick();
    const plain = store.createSession("", { title: "Plain interview" });
    store.addQuestions(plain.id, [{ prompt: "Which colour?" }]);

    const items = await inbox();
    expect(
      items.map((item) => [item.kind, item.title, item.later ?? false]),
    ).toEqual([
      ["needs_you", "Intake form", false],
      ["request", "Run the migration?", false],
      ["request", "Plain interview", false],
      ["needs_you", "Refactor", true],
    ]);
    const asked = items[1]!;
    expect(asked.brief).toBe(
      "The migration is ready; it needs a backup decision.",
    );
    expect(asked.data).toMatchObject({
      token: request.token,
      openQuestions: 2,
      interviewId: request.id,
    });
    expect(items[2]!.brief).toBe("Which colour?");
    expect(items[0]!.brief).toBe("Claude needs your permission to use Bash");

    // Once answered, the session's own item stays away while it runs.
    for (const question of store.getSession(request.id, "").questions)
      store.answerQuestion(request.id, question.id, { answer: "Yes" });
    await report({ id: "asker", status: "running" });
    expect((await inbox()).map((item) => item.title)).not.toContain(
      "D1 migration",
    );
  });
});

describe("new inbox item push", () => {
  it("seeds on the first check, then pushes once per new item", async () => {
    vi.useFakeTimers();
    const { report, store, sent } = harness();
    store.addPushSubscription("https://fcm.googleapis.com/fcm/send/phone");
    await report({ id: "a", title: "A", status: "needs_you" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(0);

    await report({ id: "b", title: "B", status: "needs_you" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1);

    // An update to an item already pushed, and a Stop after a
    // Notification, are the same wait.
    await report({ id: "b", status: "needs_you", message: "Still waiting" });
    await report({ id: "a", status: "idle" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1);

    // Running again, then waiting again, is a new item.
    await report({ id: "b", status: "running" });
    await vi.advanceTimersByTimeAsync(2_000);
    await report({ id: "b", status: "idle" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(2);
  });

  it("leaves requests to the existing question push", async () => {
    vi.useFakeTimers();
    const { report, store, sent } = harness();
    store.addPushSubscription("https://fcm.googleapis.com/fcm/send/phone");
    await report({ id: "seed", status: "running" });
    await vi.advanceTimersByTimeAsync(2_000);
    const session = store.createSession("", {});
    store.addQuestions(session.id, [{ prompt: "One?" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1);
  });
});

describe("reported links", () => {
  it("accepts only http(s) PR URLs, so none becomes a script link", async () => {
    const { app } = harness();
    const post = (prUrl: string) =>
      app.inject({
        method: "POST",
        url: "/api/sessions/kim/report",
        payload: { id: "s-link", status: "running", prUrl },
      });
    expect((await post("javascript:alert(1)")).statusCode).toBe(400);
    expect((await post("https://github.com/o/r/pull/3")).statusCode).toBe(200);
  });
});
