import { afterEach, describe, expect, it, vi } from "vitest";
import { BacklogSyncOutputSchema } from "../src/shared/backlog.js";
import {
  labelPriority,
  mapGithubBacklog,
  type GithubIssue,
} from "../src/server/features/backlogGithub.js";
import { hubHarness } from "./helpers/harness.js";

const closers: Array<() => void> = [];
afterEach(() => {
  closers.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});
function harness(env: { githubToken?: string } = {}) {
  const result = hubHarness({ env });
  closers.push(() => result.sql.close());
  return result;
}

const KEY = "github.com/tim/interviewer";
const kim = (path: string) => `/api/sessions/kim${path}`;
const browser = (path: string) => `/api/browser/kim${path}`;

const issue = (overrides: Partial<GithubIssue>): GithubIssue => ({
  number: 1,
  title: "An issue",
  state: "open",
  html_url: `https://github.com/tim/interviewer/issues/${overrides.number ?? 1}`,
  labels: [],
  ...overrides,
});

/** A GitHub API stand-in: issues and milestones by query, and issue creation. */
function stubGithub(
  data: {
    open?: GithubIssue[];
    closed?: GithubIssue[];
    milestones?: unknown[];
  } = {},
) {
  const calls: {
    url: string;
    method: string;
    body?: unknown;
    headers: Record<string, string>;
  }[] = [];
  const stub = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: init?.headers as Record<string, string>,
      });
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method === "POST" && url.endsWith("/issues"))
        return json(
          {
            number: 42,
            title: (JSON.parse(String(init!.body)) as { title: string }).title,
            html_url: "https://github.com/tim/interviewer/issues/42",
          },
          201,
        );
      if (url.includes("/milestones")) return json(data.milestones ?? []);
      if (url.includes("state=closed")) return json(data.closed ?? []);
      if (url.includes("state=open")) return json(data.open ?? []);
      return json({ message: "Not Found" }, 404);
    },
  );
  vi.stubGlobal("fetch", stub);
  return calls;
}

describe("sync output", () => {
  it("accepts the normalised shape, treating nulls as absent and cutting long bodies", () => {
    const parsed = BacklogSyncOutputSchema.parse({
      items: [
        {
          sourceId: 7,
          title: "Ship it",
          status: "in_progress",
          url: null,
          milestone: "Cycle 12",
          priority: 1,
          labels: ["bug"],
          body: "x".repeat(5000),
        },
      ],
      milestones: [
        { sourceId: "c12", name: "Cycle 12", due: "2026-10-24T07:00:00Z" },
      ],
    });
    expect(parsed.items[0]).toMatchObject({ sourceId: "7", url: undefined });
    expect(parsed.items[0]!.body).toHaveLength(4000);
    expect(parsed.milestones![0]!.due).toBe("2026-10-24");
  });

  it("rejects unknown statuses and missing titles", () => {
    expect(
      BacklogSyncOutputSchema.safeParse({
        items: [{ sourceId: "1", title: "A", status: "doing" }],
      }).success,
    ).toBe(false);
    expect(
      BacklogSyncOutputSchema.safeParse({
        items: [{ sourceId: "1", status: "todo" }],
      }).success,
    ).toBe(false);
  });
});

describe("GitHub mapping", () => {
  it("maps state, in-progress, priority and milestone, skips PRs, and orders by due date, priority, number", () => {
    const output = mapGithubBacklog(
      [
        issue({ number: 9, title: "Later, no milestone" }),
        issue({
          number: 5,
          title: "Assigned",
          assignee: { login: "tim" },
          milestone: { number: 2, title: "M2" },
          labels: [{ name: "P2" }],
        }),
        issue({
          number: 6,
          title: "Labelled in progress",
          milestone: { number: 2, title: "M2" },
          labels: [{ name: "In progress" }, { name: "priority: high" }],
          body: "y".repeat(5000),
        }),
        issue({
          number: 3,
          title: "Due sooner",
          milestone: { number: 1, title: "M1" },
        }),
        issue({ number: 4, title: "Closed", state: "closed" }),
        issue({ number: 8, title: "A PR", pull_request: {} }),
      ],
      [
        {
          number: 2,
          title: "M2",
          due_on: "2026-11-01T07:00:00Z",
          html_url: "m2",
        },
        {
          number: 1,
          title: "M1",
          due_on: "2026-10-24T07:00:00Z",
          html_url: "m1",
        },
      ],
    );
    expect(output.items.map((item) => [item.sourceId, item.status])).toEqual([
      ["3", "todo"],
      ["6", "in_progress"],
      ["5", "in_progress"],
      ["4", "done"],
      ["9", "todo"],
    ]);
    const six = output.items.find((item) => item.sourceId === "6")!;
    expect(six).toMatchObject({ milestone: "2", priority: 1 });
    expect(six.body).toHaveLength(4000);
    expect(output.milestones).toContainEqual({
      sourceId: "1",
      name: "M1",
      due: "2026-10-24",
      url: "m1",
    });
  });

  it("reads priority labels", () => {
    expect(labelPriority(["P0"])).toBe(0);
    expect(labelPriority(["bug", "p3", "priority: high"])).toBe(1);
    expect(labelPriority(["priority/low"])).toBe(3);
    expect(labelPriority(["bug"])).toBeUndefined();
  });

  it("syncs a GitHub project on the server with the token's headers", async () => {
    const { app } = harness({ githubToken: "test" });
    const calls = stubGithub({
      open: [
        issue({
          number: 1,
          title: "Open one",
          milestone: { number: 1, title: "M1" },
        }),
      ],
      closed: [
        issue({
          number: 2,
          title: "Closed lately",
          state: "closed",
          closed_at: new Date().toISOString(),
          milestone: { number: 1, title: "M1" },
        }),
        issue({
          number: 3,
          title: "Closed long ago",
          state: "closed",
          closed_at: "2020-01-01T00:00:00Z",
        }),
      ],
      milestones: [{ number: 1, title: "M1", due_on: null, html_url: "m1" }],
    });
    const response = await app.inject({
      method: "POST",
      url: kim("/backlog/sync"),
      payload: { project: KEY },
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]!.url).toMatch(
      /^https:\/\/api\.github\.com\/repos\/tim\/interviewer\//,
    );
    expect(calls[0]!.headers).toMatchObject({
      authorization: "Bearer test",
      "x-github-api-version": "2022-11-28",
    });
    const body = response.json();
    expect(body.milestone).toMatchObject({ name: "M1", done: 1, total: 2 });
    expect(
      body.upNext.map((item: { sourceId: string }) => item.sourceId),
    ).toEqual(["1"]);
    expect(body.settings).toMatchObject({ source: "github", syncError: null });
    expect(body.settings.syncedAt).toBeTruthy();
  });

  it("records a failed sync on the project", async () => {
    const { app } = harness({ githubToken: "test" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Bad credentials" }), {
            status: 401,
          }),
      ),
    );
    const projectId = (
      await app.inject({ method: "GET", url: kim(`/backlog?project=${KEY}`) })
    ).json().project.id;
    const sync = await app.inject({
      method: "POST",
      url: browser(`/projects/${projectId}/backlog/sync`),
    });
    expect(sync.statusCode).toBe(502);
    const view = (
      await app.inject({
        method: "GET",
        url: browser(`/projects/${projectId}/backlog`),
      })
    ).json();
    expect(view.settings.syncError).toBe("GitHub 401: Bad credentials");
  });

  it("syncs one waiting GitHub project per tick, then leaves it for 15 minutes", async () => {
    const { app, hub } = harness({ githubToken: "test" });
    const calls = stubGithub({ open: [issue({ number: 1 })] });
    await app.inject({ method: "GET", url: kim(`/backlog?project=${KEY}`) });
    await app.inject({
      method: "GET",
      url: kim("/backlog?project=github.com/tim/other"),
    });
    await hub.tick();
    // The PRs feature's tick shares the stubbed fetch; count backlog calls only.
    const backlogCalls = () =>
      calls.filter((call) => /\/(issues|milestones)\b/.test(call.url));
    const repos = () =>
      new Set(backlogCalls().map((call) => call.url.split("/")[5])).size;
    expect(repos()).toBe(1);
    await hub.tick();
    expect(repos()).toBe(2);
    const before = backlogCalls().length;
    await hub.tick();
    expect(backlogCalls().length).toBe(before);
  });
});

describe("script sync", () => {
  it("hands the CLI the saved script, then replaces source items and keeps local ones", async () => {
    const { app } = harness();
    await app.inject({
      method: "POST",
      url: kim("/backlog/settings"),
      payload: { project: KEY, source: "script", script: "console.log('{}')" },
    });
    const sync = await app.inject({
      method: "POST",
      url: kim("/backlog/sync"),
      payload: { project: KEY },
    });
    expect(sync.json().script).toBe("console.log('{}')");

    const post = (items: unknown[]) =>
      app.inject({
        method: "POST",
        url: kim("/backlog/items"),
        payload: { project: KEY, output: { items } },
      });
    await post([
      { sourceId: "ENG-1", title: "One", status: "todo" },
      { sourceId: "ENG-2", title: "Two", status: "todo" },
    ]);
    // A follow-up accepted here becomes a local item.
    const { followUps } = (
      await app.inject({
        method: "POST",
        url: kim("/followups"),
        payload: { projectKey: KEY, items: ["Local thing"] },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: browser(`/followups/${followUps[0].id}`),
      payload: { action: "accept" },
    });
    const replaced = await post([
      { sourceId: "ENG-3", title: "Three", status: "in_progress", priority: 0 },
      { sourceId: "ENG-2", title: "Two, renamed", status: "todo" },
    ]);
    expect(replaced.statusCode).toBe(200);
    const { items } = (
      await app.inject({ method: "GET", url: kim(`/backlog?project=${KEY}`) })
    ).json();
    expect(
      items.map((item: { title: string; origin: string }) => [
        item.title,
        item.origin,
      ]),
    ).toEqual([
      ["Three", "source"],
      ["Two, renamed", "source"],
      ["Local thing", "local"],
    ]);
  });

  it("refuses output of the wrong shape and records why", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "POST",
      url: kim("/backlog/items"),
      payload: { project: KEY, output: { items: [{ title: "No id" }] } },
    });
    expect(response.statusCode).toBe(400);
    await app.inject({
      method: "POST",
      url: kim("/backlog/error"),
      payload: { project: KEY, error: "script exited 1" },
    });
    const { settings } = (
      await app.inject({ method: "GET", url: kim(`/backlog?project=${KEY}`) })
    ).json();
    expect(settings.syncError).toBe("script exited 1");
  });

  it("tells the browser to run the CLI for a script source", async () => {
    const { app } = harness();
    const { project } = (
      await app.inject({
        method: "POST",
        url: kim("/backlog/settings"),
        payload: { project: KEY, source: "script" },
      })
    ).json();
    const response = await app.inject({
      method: "POST",
      url: browser(`/projects/${project.id}/backlog/sync`),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().command).toBe(
      `interviewer backlog sync --project ${KEY}`,
    );
  });
});

describe("current milestone", () => {
  const setup = async () => {
    const { app } = harness();
    const post = (output: unknown) =>
      app.inject({
        method: "POST",
        url: kim("/backlog/items"),
        payload: { project: KEY, output },
      });
    const current = async () =>
      (
        await app.inject({ method: "GET", url: kim(`/backlog?project=${KEY}`) })
      ).json().milestone;
    return { app, post, current };
  };

  it("picks the nearest due milestone with open items", async () => {
    const { post, current } = await setup();
    await post({
      milestones: [
        { sourceId: "a", name: "Finished", due: "2026-10-01" },
        { sourceId: "b", name: "Soon", due: "2026-10-20" },
        { sourceId: "c", name: "Later", due: "2026-12-01" },
        { sourceId: "d", name: "Undated" },
      ],
      items: [
        { sourceId: "1", title: "1", status: "done", milestone: "a" },
        { sourceId: "2", title: "2", status: "todo", milestone: "b" },
        { sourceId: "3", title: "3", status: "done", milestone: "b" },
        { sourceId: "4", title: "4", status: "in_progress", milestone: "b" },
        { sourceId: "5", title: "5", status: "cancelled", milestone: "b" },
        { sourceId: "6", title: "6", status: "todo", milestone: "c" },
        { sourceId: "7", title: "7", status: "todo", milestone: "d" },
        { sourceId: "8", title: "8", status: "todo", milestone: "d" },
      ],
    });
    expect(await current()).toMatchObject({
      name: "Soon",
      due: "2026-10-20",
      done: 1,
      inProgress: 1,
      total: 3,
    });
  });

  it("falls back to the milestone with the most open items, then none", async () => {
    const { post, current } = await setup();
    await post({
      items: [
        { sourceId: "1", title: "1", status: "todo", milestone: "Cycle 12" },
        { sourceId: "2", title: "2", status: "todo", milestone: "Cycle 13" },
        { sourceId: "3", title: "3", status: "todo", milestone: "Cycle 13" },
      ],
    });
    expect((await current()).name).toBe("Cycle 13");
    await post({ items: [{ sourceId: "1", title: "1", status: "todo" }] });
    expect(await current()).toBeNull();
  });

  it("lets an override win, including a manual milestone", async () => {
    const { app, post, current } = await setup();
    await post({
      milestones: [{ sourceId: "b", name: "Soon", due: "2026-10-20" }],
      items: [{ sourceId: "1", title: "1", status: "todo", milestone: "b" }],
    });
    await app.inject({
      method: "POST",
      url: kim("/backlog/milestones"),
      payload: { project: KEY, name: "Launch", due: "2026-11-30" },
    });
    await app.inject({
      method: "POST",
      url: kim("/backlog/settings"),
      payload: { project: KEY, milestone: "Launch" },
    });
    expect(await current()).toMatchObject({
      name: "Launch",
      manual: true,
      due: "2026-11-30",
    });
    await app.inject({
      method: "POST",
      url: kim("/backlog/settings"),
      payload: { project: KEY, milestone: null },
    });
    expect((await current()).name).toBe("Soon");
  });

  it("shows on the project rail", async () => {
    const { app, post } = await setup();
    await post({
      milestones: [{ sourceId: "b", name: "Soon", due: "2026-10-20" }],
      items: [
        { sourceId: "1", title: "1", status: "todo", milestone: "b" },
        { sourceId: "2", title: "2", status: "done", milestone: "b" },
      ],
    });
    await app.inject({
      method: "GET",
      url: kim("/backlog?project=github.com/tim/empty"),
    });
    const { projects } = (
      await app.inject({ method: "GET", url: browser("/projects") })
    ).json();
    const stats = Object.fromEntries(
      projects.map((project: { key: string; stats: unknown }) => [
        project.key,
        project.stats,
      ]),
    );
    expect(stats[KEY].milestone).toEqual({
      name: "Soon",
      due: "2026-10-20",
      done: 1,
      total: 2,
    });
    expect(stats["github.com/tim/empty"].milestone).toBeNull();
  });
});

describe("follow-ups", () => {
  const report = (
    app: ReturnType<typeof harness>["app"],
    items: string[],
    projectKey = KEY,
  ) =>
    app.inject({
      method: "POST",
      url: kim("/followups"),
      payload: { projectKey, agentSessionId: "session-abc12345", items },
    });

  it("dedupes open text and shows one inbox item per project", async () => {
    const { app } = harness();
    await report(app, ["Add rate limiting", "Rename state to status"]);
    const again = (
      await report(app, ["Add rate limiting", "Document states", "Fifth"])
    ).json();
    expect(again.skipped).toBe(1);
    await report(app, ["Elsewhere"], "github.com/tim/other");
    const { items } = (
      await app.inject({ method: "GET", url: browser("/inbox") })
    ).json();
    const mine = items.find(
      (item: { title: string }) => item.title === "4 follow-ups",
    );
    expect(mine).toMatchObject({
      kind: "follow_ups",
      source: "session session-",
      brief:
        "Left undone: Add rate limiting; Rename state to status; Document states; and 1 more.",
    });
    expect(mine.id).toBe(`follow_ups:${mine.projectId}`);
    expect(mine.data.followUps).toHaveLength(4);
    expect(mine.data.followUps[0]).toMatchObject({
      text: "Add rate limiting",
      agentSessionId: "session-abc12345",
    });
    expect(
      items.filter((item: { kind: string }) => item.kind === "follow_ups"),
    ).toHaveLength(2);
  });

  it("accepting on a GitHub project opens an issue and adds it to the backlog", async () => {
    const { app } = harness({ githubToken: "test" });
    const calls = stubGithub();
    const { followUps, project } = (
      await report(app, ["Add rate limiting"])
    ).json();
    const response = await app.inject({
      method: "POST",
      url: browser(`/followups/${followUps[0].id}`),
      payload: { action: "accept" },
    });
    expect(response.json().followUp).toMatchObject({
      state: "accepted",
      backlogSourceId: "42",
    });
    const created = calls.find((call) => call.method === "POST")!;
    expect(created.url).toBe(
      "https://api.github.com/repos/tim/interviewer/issues",
    );
    expect(created.body).toMatchObject({ title: "Add rate limiting" });
    const view = (
      await app.inject({
        method: "GET",
        url: browser(`/projects/${project.id}/backlog`),
      })
    ).json();
    expect(view.upNext[0]).toMatchObject({
      sourceId: "42",
      origin: "source",
      url: "https://github.com/tim/interviewer/issues/42",
    });
    const open = (
      await app.inject({
        method: "GET",
        url: browser(`/projects/${project.id}/followups?state=open`),
      })
    ).json();
    expect(open.followUps).toEqual([]);
  });

  it("accepting without a token adds a local item", async () => {
    const { app } = harness();
    const { followUps, project } = (await report(app, ["Write docs"])).json();
    await app.inject({
      method: "POST",
      url: browser(`/followups/${followUps[0].id}`),
      payload: { action: "accept" },
    });
    const view = (
      await app.inject({
        method: "GET",
        url: browser(`/projects/${project.id}/backlog`),
      })
    ).json();
    expect(view.settings.source).toBe("none");
    expect(view.upNext[0]).toMatchObject({
      title: "Write docs",
      origin: "local",
    });
  });

  it("dismisses, and starts with a command to copy", async () => {
    const { app } = harness();
    const { followUps } = (
      await report(app, ["Drop it", `Fix "quotes" $HOME it's $(rm -rf ~)`])
    ).json();
    const dismissed = await app.inject({
      method: "POST",
      url: browser(`/followups/${followUps[0].id}`),
      payload: { action: "dismiss" },
    });
    expect(dismissed.json().followUp.state).toBe("dismissed");
    const started = (
      await app.inject({
        method: "POST",
        url: browser(`/followups/${followUps[1].id}`),
        payload: { action: "start" },
      })
    ).json();
    expect(started.followUp.state).toBe("started");
    // Single-quoted, so nothing in the text expands in a shell.
    expect(started.command).toBe(
      `claude 'Fix "quotes" $HOME it'\\''s $(rm -rf ~)'`,
    );
    const { items } = (
      await app.inject({ method: "GET", url: browser("/inbox") })
    ).json();
    expect(items).toEqual([]);
    // A dismissed one can be reported again.
    expect((await report(app, ["Drop it"])).json().followUps).toHaveLength(1);
  });

  it("accepts on arrival when auto-write is on", async () => {
    const { app } = harness({ githubToken: "test" });
    const calls = stubGithub();
    await app.inject({
      method: "POST",
      url: kim("/backlog/settings"),
      payload: { project: KEY, autoWrite: true },
    });
    const { followUps } = (await report(app, ["Automatic"])).json();
    expect(followUps[0]).toMatchObject({
      state: "accepted",
      backlogSourceId: "42",
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    const { items } = (
      await app.inject({ method: "GET", url: browser("/inbox") })
    ).json();
    expect(items).toEqual([]);
  });
});
