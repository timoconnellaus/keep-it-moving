import { afterEach, describe, expect, it } from "vitest";
import { normalizeRemote } from "../src/shared/remote.js";
import { hubHarness } from "./helpers/harness.js";

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((close) => close()));
function harness() {
  const result = hubHarness();
  closers.push(() => result.sql.close());
  return result;
}

describe("git remotes", () => {
  it("names a repo the same way from SSH, HTTPS and a cloud sandbox's proxy", () => {
    for (const remote of [
      "git@github.com:timoconnellaus/frockbot.git",
      "https://github.com/timoconnellaus/frockbot",
      "https://github.com/timoconnellaus/frockbot.git/",
      "http://local_proxy@127.0.0.1:41235/git/timoconnellaus/frockbot",
    ])
      expect(normalizeRemote(remote)).toBe(
        "github.com/timoconnellaus/frockbot",
      );
  });
});

describe("projects", () => {
  it("puts every interview from one remote in one project with a fixed colour", () => {
    const { store } = harness();
    const create = (origin: Record<string, string>) =>
      store.createSession("https://interviewer.test", { title: "T", origin });
    const local = create({
      projectKey: "github.com/timoconnellaus/frockbot",
      branch: "claude/checkout",
      worktree: "frockbot-checkout",
      agent: "Claude Code",
      agentSession: "Checkout redesign",
      location: "local",
    });
    const cloud = create({
      projectKey: "github.com/timoconnellaus/frockbot",
      location: "cloud",
    });
    const other = create({ projectKey: "github.com/timoconnellaus/pocketdoc" });

    expect(local.project).toMatchObject({
      name: "Frockbot",
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
    });
    expect(cloud.project).toEqual(local.project);
    expect(other.project?.color).not.toBe(local.project?.color);
    expect(local.origin).toEqual({
      branch: "claude/checkout",
      worktree: "frockbot-checkout",
      agent: "Claude Code",
      agentSession: "Checkout redesign",
      location: "local",
    });
  });

  it("lets the agent name an existing project", () => {
    const { store } = harness();
    const first = store.createSession("", {
      origin: { projectKey: "github.com/o/frockbot" },
    });
    // A session without the remote finds it by name, case-insensitively.
    const named = store.createSession("", {
      origin: { project: "FROCKBOT", projectKey: "local/elsewhere" },
    });
    expect(named.project).toEqual(first.project);
    expect(store.listProjects()).toHaveLength(1);
  });

  it("summarises every interview for the switcher, counting what waits on the user", async () => {
    const { app, store } = harness();
    const a = store.createSession("", {
      title: "Checkout",
      origin: { projectKey: "github.com/o/frockbot" },
    });
    const [q1] = store.addQuestions(a.id, [
      { prompt: "One?" },
      { prompt: "Two?" },
    ]);
    store.answerQuestion(a.id, q1!.id, { answer: "Yes" });
    const b = store.createSession("", { title: "Done" });
    store.addQuestions(b.id, [{ prompt: "Three?" }]);
    store.setSessionStatus(b.id, "stopped");

    const overview = (
      await app.inject({ method: "GET", url: "/api/browser/overview" })
    ).json();
    const byTitle = Object.fromEntries(
      overview.sessions.map((item: { title: string }) => [item.title, item]),
    );
    expect(byTitle.Checkout).toMatchObject({
      answered: 1,
      total: 2,
      open: 1,
      token: a.token,
      project: { name: "Frockbot" },
    });
    // A finished interview no longer waits on anyone.
    expect(byTitle.Done).toMatchObject({
      open: 0,
      status: "stopped",
      project: null,
    });
  });

  it("pings every open page when an interview's place in the switcher changes", async () => {
    const pings: string[] = [];
    const { store } = hubHarness({
      sockets: { send: () => undefined, sendAll: (data) => pings.push(data) },
    });
    const session = store.createSession("", {});
    store.addQuestions(session.id, [{ prompt: "One?" }]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A burst of changes sends one ping.
    expect(pings).toEqual([JSON.stringify({ type: "overview" })]);
  });

  it("pings open pages when a chat message changes who an interview waits on", async () => {
    const pings: string[] = [];
    const { store } = hubHarness({
      sockets: { send: () => undefined, sendAll: (data) => pings.push(data) },
    });
    const session = store.createSession("", {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    pings.length = 0;
    store.addChatMessage(session.id, "user", { text: "Why A?" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pings).toEqual([JSON.stringify({ type: "overview" })]);
  });
});
