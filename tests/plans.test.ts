import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESPONDENT_HEADER } from "../src/server/hub.js";
import { PLAN_HEADER } from "../src/server/plans.js";
import { hubHarness } from "./helpers/harness.js";
import { serveHarness } from "./helpers/serve.js";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) await cleanups.pop()?.();
});

/** The hub's timers, which would outlive a test's database, run on demand. */
const fakeTimers = () =>
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

/** A hub, as the Worker sends a user on `plan` to it, with some interviews. */
function setup(plan: "free" | "pro" = "free", count = 5) {
  const harness = hubHarness();
  cleanups.push(() => harness.sql.close());
  const { store, app, agents } = harness;
  const sessions = Array.from({ length: count }, (_, index) =>
    store.createSession("", { title: `Interview ${index + 1}` }),
  );
  const headers = { [PLAN_HEADER]: plan };
  /** An agent starts waiting on an interview over its socket. */
  const watch = (id: string) =>
    app.fetch(
      new Request(`https://hub/api/sessions/${id}/socket?mode=wait`, {
        headers: { ...headers, upgrade: "websocket" },
      }),
    );
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, payload, headers });
  return { ...harness, store, agents, sessions, watch, call };
}

describe("the Free plan's live interviews", () => {
  fakeTimers();
  it("lets three agents wait and refuses a fourth, naming the three", async () => {
    const { sessions, watch, agents } = setup();
    for (const session of sessions.slice(0, 3))
      expect((await watch(session.id)).status).toBe(200);
    const refused = await watch(sessions[3]!.id);
    expect(refused.status).toBe(402);
    const body = await refused.json();
    expect(body).toMatchObject({
      code: "plan_limit",
      plan: "free",
      feature: "live",
      limit: 3,
      upgradeUrl: "https://interviewer.test/pricing",
    });
    expect(body.live.map((live: { title: string }) => live.title)).toEqual([
      "Interview 1",
      "Interview 2",
      "Interview 3",
    ]);
    expect(body.error).toContain('"Interview 2"');
    expect(body.error).toContain("kim session stop");
    // Nobody already waiting was ended to make room.
    expect(agents.list()).toHaveLength(3);
    expect(agents.all.every((socket) => !socket.closed)).toBe(true);
  });

  it("refuses the older HTTP waits the same way", async () => {
    const { sessions, watch, call } = setup();
    for (const session of sessions.slice(0, 3)) await watch(session.id);
    const id = sessions[3]!.id;
    for (const path of ["wait?timeout=0", "events/next?timeout=0", "attach"]) {
      const response = await call("GET", `/api/sessions/${id}/${path}`);
      expect(response.statusCode).toBe(402);
      expect(response.json().code).toBe("plan_limit");
    }
  });

  it("doesn't count half-done interviews nobody is waiting on", async () => {
    const { sessions, store, watch } = setup("free", 6);
    // Three interviews part-answered, with no agent waiting.
    for (const session of sessions.slice(0, 3)) {
      const [question] = store.addQuestions(session.id, [
        { prompt: "One?" },
        { prompt: "Two?" },
      ]);
      store.answerQuestion(session.id, question!.id, { answer: "Yes" });
    }
    for (const session of sessions.slice(3))
      expect((await watch(session.id)).status).toBe(200);
  });

  it("lets an agent take over an interview already live, and frees a place when one stops", async () => {
    const { sessions, watch, agents, store } = setup();
    for (const session of sessions.slice(0, 3)) await watch(session.id);
    // A newer watcher on a live interview only takes its place.
    expect((await watch(sessions[0]!.id)).status).toBe(200);
    expect(agents.list()).toHaveLength(3);
    // A stopped interview isn't live, even with an agent still on it.
    store.setSessionStatus(sessions[1]!.id, "stopped");
    expect((await watch(sessions[3]!.id)).status).toBe(200);
    expect((await watch(sessions[4]!.id)).status).toBe(402);
    // An agent that goes away holds its place a moment, for a chained wait.
    agents.list(sessions[2]!.id)[0]!.disconnect();
    expect((await watch(sessions[4]!.id)).status).toBe(402);
    await vi.advanceTimersByTimeAsync(5_100);
    expect((await watch(sessions[4]!.id)).status).toBe(200);
  });

  it("has no limit on Pro", async () => {
    const { sessions, watch, agents } = setup("pro");
    for (const session of sessions)
      expect((await watch(session.id)).status).toBe(200);
    expect(agents.list()).toHaveLength(5);
  });
});

describe("assigning on the Free plan", () => {
  fakeTimers();
  it("is refused, from the agent and the page", async () => {
    const { sessions, call } = setup("free", 1);
    const session = sessions[0]!;
    for (const url of [
      `/api/sessions/${session.id}/assign`,
      `/api/browser/${session.token}/assign`,
    ]) {
      const response = await call("POST", url, { email: "bob@example.com" });
      expect(response.statusCode).toBe(402);
      expect(response.json()).toMatchObject({
        code: "plan_limit",
        feature: "assign",
        upgradeUrl: "https://interviewer.test/pricing",
      });
    }
  });

  it("keeps an earlier assignment working, and lets the owner take it back", async () => {
    const { sessions, store, app, call } = setup("free", 1);
    const session = sessions[0]!;
    const [question] = store.addQuestions(session.id, [{ prompt: "When?" }]);
    store.assignSession(session.id, "bob@example.com", "Ann");
    const answered = await app.inject({
      method: "POST",
      url: `/api/browser/${session.token}/questions/${question!.id}/answer`,
      payload: { answer: "Friday" },
      headers: {
        [PLAN_HEADER]: "free",
        [RESPONDENT_HEADER]: "bob@example.com",
      },
    });
    expect(answered.statusCode).toBe(200);
    const cleared = await call("POST", `/api/sessions/${session.id}/assign`, {
      email: null,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      assignee: null,
      previous: "bob@example.com",
    });
  });

  it("is allowed on Pro", async () => {
    const { sessions, call } = setup("pro", 1);
    const response = await call(
      "POST",
      `/api/sessions/${sessions[0]!.id}/assign`,
      { email: "bob@example.com" },
    );
    expect(response.statusCode).toBe(200);
  });
});

describe("kim on the Free plan", () => {
  const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
    .pathname;
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;

  /** The hub served as a Worker would for a Free user. */
  async function served() {
    const harness = setup("free", 4);
    const server = await serveHarness(harness, (request) => {
      const forwarded = new Request(request);
      forwarded.headers.set(PLAN_HEADER, "free");
      return harness.app.fetch(forwarded);
    });
    cleanups.push(() => server.close());
    const kim = (...args: string[]) =>
      exec(process.execPath, [tsx, cli, ...args], {
        env: {
          ...process.env,
          KEEP_IT_MOVING_URL: server.address,
          KEEP_IT_MOVING_TOKEN: "test",
        },
      });
    return { ...harness, kim };
  }

  it("prints the refusal plainly when a fourth agent starts waiting", async () => {
    const { sessions, watch, kim } = await served();
    for (const session of sessions.slice(0, 3)) await watch(session.id);
    const failed = await kim("wait", sessions[3]!.id, "--timeout", "5000").then(
      () => null,
      (error: { code: number; stderr: string }) => error,
    );
    expect(failed?.code).toBe(1);
    const printed = JSON.parse(failed!.stderr.trim().split("\n").at(-1)!);
    expect(printed).toMatchObject({
      code: "plan_limit",
      upgradeUrl: "https://interviewer.test/pricing",
    });
    expect(printed.error).toMatch(/Free plan.*at most 3 interviews/);
    expect(printed.live).toHaveLength(3);
  });

  it("says the interview was made when --assign is refused", async () => {
    const { kim } = await served();
    const failed = await kim(
      "session",
      "create",
      "--title",
      "Venue survey",
      "--assign",
      "bob@example.com",
    ).then(
      () => null,
      (error: { code: number; stderr: string }) => error,
    );
    expect(failed?.code).toBe(1);
    const printed = JSON.parse(failed!.stderr.trim().split("\n").at(-1)!);
    expect(printed.error).toContain("Pro feature");
    expect(printed.error).toContain("created without an assignee");
    expect(printed).toMatchObject({
      code: "plan_limit",
      feature: "assign",
      session: { title: "Venue survey", assignee: null },
    });
  });
});
