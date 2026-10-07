import { afterEach, describe, expect, it } from "vitest";
import { hubHarness } from "./helpers/harness.js";

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

const KEY = "github.com/tim/interviewer";
const HOUR = 3_600_000;
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function harness(pings: string[] = []) {
  const result = hubHarness({
    sockets: { send: () => undefined, sendAll: (data) => pings.push(data) },
  });
  closers.push(() => result.sql.close());
  const { app } = result;
  const post = async (url: string, payload: unknown) => {
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return response.json();
  };
  const get = (url: string) => app.inject({ method: "GET", url });
  const context = async (project = KEY) => {
    const response = await get(
      `/api/sessions/kim/projects/context?project=${encodeURIComponent(project)}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const summarise = (payload: Record<string, unknown>) =>
    post("/api/sessions/kim/projects/summary", { project: KEY, ...payload });
  return { ...result, post, get, context, summarise };
}

/** A project with a session, a backlog, a follow-up, a PR and an automation. */
async function seed(h: ReturnType<typeof harness>) {
  await h.post("/api/sessions/kim/report", {
    id: "cc-1",
    projectKey: KEY,
    title: "Fix watcher lease",
    status: "idle",
    branch: "kim/lease",
    brief: "Lease fixed; PR open.",
  });
  const project = h.store.projectForKey(KEY);
  await h.post("/api/sessions/kim/backlog/items", {
    project: KEY,
    output: {
      milestones: [{ sourceId: "2", name: "M2 · Hosted", due: "2026-10-24" }],
      items: [
        {
          sourceId: "1",
          title: "Agent sessions",
          status: "done",
          milestone: "2",
        },
        {
          sourceId: "2",
          title: "Backlog sync",
          status: "in_progress",
          milestone: "2",
        },
        { sourceId: "3", title: "Summaries", status: "todo", milestone: "2" },
        { sourceId: "4", title: "Old idea", status: "cancelled" },
      ],
    },
  });
  await h.post("/api/sessions/kim/followups", {
    projectKey: KEY,
    agentSessionId: "cc-1",
    items: ["Add rate limiting"],
  });
  h.sql.all(
    `INSERT INTO prs (project_id, number, title, url, head_ref, head_sha, author, ci, ready,
       failing, updated_at, synced_at)
     VALUES (?, 12, 'Watcher lease', 'https://github.com/tim/interviewer/pull/12', 'kim/lease',
       'abc', 'tim', 'red', 0, '["test"]', ?, ?)`,
    project.id,
    at(HOUR),
    at(0),
  );
  await h.post("/api/sessions/kim/heartbeat", {
    project: KEY,
    name: "babysitter",
    every: 300,
    machine: "tim-mbp",
  });
  return project;
}

describe("project context", () => {
  it("gathers what each feature knows about the project in one object", async () => {
    const h = harness();
    const project = await seed(h);
    // A session from more than a week ago is left out.
    await h.post("/api/sessions/kim/report", {
      id: "cc-old",
      projectKey: KEY,
      title: "Ancient",
    });
    h.sql.all(
      "UPDATE agent_sessions SET updated_at = ? WHERE id = 'cc-old'",
      at(8 * 24 * HOUR),
    );
    await h.summarise({ text: "Earlier summary." });

    const context = await h.context();
    expect(context.project).toEqual({
      id: project.id,
      key: KEY,
      name: project.name,
    });
    expect(context.milestone).toMatchObject({
      name: "M2 · Hosted",
      due: "2026-10-24",
      done: 1,
      inProgress: 1,
      total: 3,
    });
    expect(context.backlog.counts).toEqual({
      todo: 1,
      inProgress: 1,
      done: 1,
      total: 3,
    });
    expect(
      context.inProgress.map((item: { title: string }) => item.title),
    ).toEqual(["Backlog sync"]);
    expect(context.upNext.map((item: { title: string }) => item.title)).toEqual(
      ["Summaries"],
    );
    expect(context.followUps).toMatchObject([
      { text: "Add rate limiting", agentSessionId: "cc-1" },
    ]);
    expect(context.sessions).toEqual([
      expect.objectContaining({
        id: "cc-1",
        title: "Fix watcher lease",
        status: "idle",
        brief: "Lease fixed; PR open.",
        branch: "kim/lease",
        openRequests: [],
      }),
    ]);
    expect(context.prs).toEqual([
      expect.objectContaining({
        number: 12,
        branch: "kim/lease",
        ci: "red",
        failing: ["test"],
        ready: false,
      }),
    ]);
    expect(context.automations).toEqual([
      expect.objectContaining({
        name: "babysitter",
        every: "5m",
        down: false,
        machine: "tim-mbp",
        machineAlive: true,
      }),
    ]);
    expect(context.previousSummary).toMatchObject({
      text: "Earlier summary.",
      stale: false,
    });
  });

  it("finds the project by name and keeps going when a feature's table is missing", async () => {
    const h = harness();
    const project = await seed(h);
    h.sql.exec("DROP TABLE prs");
    const context = await h.context(project.name);
    expect(context.project.key).toBe(KEY);
    expect(context.prs).toEqual([]);
    expect(context.sessions).toHaveLength(1);
    expect(context.previousSummary).toBeNull();
  });

  it("says when the project doesn't exist", async () => {
    const h = harness();
    const response = await h.get(
      "/api/sessions/kim/projects/context?project=nope",
    );
    expect(response.statusCode).toBe(404);
  });
});

describe("project summaries", () => {
  it("keeps every summary and shows the newest, with the session that wrote it", async () => {
    const h = harness();
    const project = await seed(h);
    const browser = async () =>
      (await h.get(`/api/browser/kim/projects/${project.id}/summary`)).json()
        .summary;
    expect(await browser()).toBeNull();

    await h.summarise({ text: "First." });
    const saved = await h.summarise({
      text: "  Lease fix is in review; summaries are next.  ",
      agentSessionId: "cc-1",
    });
    expect(saved.summary).toMatchObject({
      text: "Lease fix is in review; summaries are next.",
      writtenBy: "cc-1",
      writtenByTitle: "Fix watcher lease",
    });
    expect(await browser()).toMatchObject({
      text: "Lease fix is in review; summaries are next.",
      writtenByTitle: "Fix watcher lease",
      stale: false,
    });
    expect(h.sql.all("SELECT COUNT(*) n FROM project_summaries")[0]!.n).toBe(2);
    expect(
      (await h.get("/api/browser/kim/projects/missing/summary")).statusCode,
    ).toBe(404);
  });

  it("finds a cloud session by its remote id", async () => {
    const h = harness();
    await seed(h);
    await h.post("/api/sessions/kim/report", {
      id: "cc-cloud",
      remoteId: "cse_01Cloud",
      projectKey: KEY,
      title: "Cloud work",
    });
    const saved = await h.summarise({
      text: "From the cloud.",
      agentSessionId: "cse_01Cloud",
      remoteId: "cse_01Cloud",
    });
    expect(saved.summary).toMatchObject({
      writtenBy: "cc-cloud",
      writtenByTitle: "Cloud work",
    });
  });

  it("refuses an empty or overlong summary", async () => {
    const h = harness();
    await seed(h);
    for (const text of ["   ", "x".repeat(2_001)])
      expect(
        (
          await h.app.inject({
            method: "POST",
            url: "/api/sessions/kim/projects/summary",
            payload: { project: KEY, text },
          })
        ).statusCode,
      ).toBe(400);
  });

  it("is stale after a day once sessions have moved since", async () => {
    const h = harness();
    const project = await seed(h);
    await h.summarise({ text: "Old news." });
    h.sql.all("UPDATE project_summaries SET created_at = ?", at(30 * HOUR));
    const summary = async () =>
      (await h.get(`/api/browser/kim/projects/${project.id}/summary`)).json()
        .summary;
    // The session and PR moved after it was written.
    expect((await summary()).stale).toBe(true);
    h.sql.all("UPDATE agent_sessions SET updated_at = ?", at(40 * HOUR));
    h.sql.all("UPDATE prs SET updated_at = ?", at(40 * HOUR));
    expect((await summary()).stale).toBe(false);
  });

  it("tells open pages to refetch", async () => {
    const pings: string[] = [];
    const h = harness(pings);
    await seed(h);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    const before = pings.length;
    await h.summarise({ text: "Pinged." });
    await settle();
    expect(pings.length).toBeGreaterThan(before);
  });
});
