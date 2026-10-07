import { afterEach, describe, expect, it, vi } from "vitest";
import { groupByDirectory, parsePatch, prLabel } from "../src/shared/github.js";
import {
  GitHubClient,
  logExcerpt,
  rollUp,
} from "../src/server/features/github/client.js";
import { isReady, repoOf } from "../src/server/features/github/index.js";
import { hubHarness } from "./helpers/harness.js";

const closers: Array<() => void> = [];
afterEach(() => {
  closers.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

interface FakePull {
  number: number;
  title: string;
  sha: string;
  ref?: string;
  draft?: boolean;
  mergeable_state?: string;
  updated_at?: string;
}

/** A tiny GitHub: open PRs, check runs by sha, reviews, files and job logs. */
function fakeGitHub() {
  const state = {
    pulls: [] as FakePull[],
    merged: new Set<number>(),
    checks: {} as Record<string, unknown[]>,
    reviews: {} as Record<number, unknown[]>,
    files: {} as Record<number, unknown[]>,
    logs: {} as Record<number, string>,
    calls: [] as { url: string; headers: Record<string, string> }[],
  };
  const raw = (pull: FakePull, open = true) => ({
    number: pull.number,
    title: pull.title,
    html_url: `https://github.com/o/r/pull/${pull.number}`,
    state: open ? "open" : "closed",
    draft: pull.draft ?? false,
    body: "Body",
    updated_at: pull.updated_at ?? "2026-10-07T00:00:00Z",
    user: { login: "tim" },
    head: { ref: pull.ref ?? `branch-${pull.number}`, sha: pull.sha },
    base: { ref: "main" },
    merged: !open && state.merged.has(pull.number),
    additions: 10 * pull.number,
    deletions: pull.number,
    mergeable: true,
    mergeable_state: pull.mergeable_state ?? "clean",
  });
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "2000000000",
      },
    });
  const closed: FakePull[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    state.calls.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers)),
    });
    const path = new URL(url).pathname;
    let match;
    if (url.startsWith("https://blob.test/"))
      return new Response(state.logs[Number(path.split("/").pop())] ?? "");
    if (path === "/repos/o/r/pulls")
      return json(state.pulls.map((p) => raw(p)));
    if ((match = path.match(/^\/repos\/o\/r\/pulls\/(\d+)$/))) {
      const number = Number(match[1]);
      const open = state.pulls.find((p) => p.number === number);
      const gone = closed.find((p) => p.number === number);
      if (open) return json(raw(open));
      if (gone) return json(raw(gone, false));
      return new Response('{"message":"Not Found"}', { status: 404 });
    }
    if ((match = path.match(/^\/repos\/o\/r\/commits\/(\w+)\/check-runs$/)))
      return json({ check_runs: state.checks[match[1]!] ?? [] });
    if ((match = path.match(/^\/repos\/o\/r\/pulls\/(\d+)\/reviews$/)))
      return json(state.reviews[Number(match[1])] ?? []);
    if ((match = path.match(/^\/repos\/o\/r\/pulls\/(\d+)\/files$/))) {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      const all = state.files[Number(match[1])] ?? [];
      return json(all.slice((page - 1) * 100, page * 100));
    }
    if ((match = path.match(/^\/repos\/o\/r\/actions\/jobs\/(\d+)\/logs$/)))
      return new Response(null, {
        status: 302,
        headers: { location: `https://blob.test/logs/${match[1]}` },
      });
    return new Response('{"message":"Not Found"}', { status: 404 });
  });
  /** Closes an open PR, merged or not. */
  const close = (number: number, merged: boolean) => {
    const index = state.pulls.findIndex((p) => p.number === number);
    closed.push(...state.pulls.splice(index, 1));
    if (merged) state.merged.add(number);
  };
  return { state, fetch, close };
}

const run = (
  name: string,
  conclusion: string | null,
  id = 1,
  actions = true,
) => ({
  id,
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  html_url: `https://github.com/o/r/runs/${id}`,
  details_url: null,
  app: { slug: actions ? "github-actions" : "vercel" },
});

function harness(env: { githubToken?: string } = { githubToken: "test" }) {
  const result = hubHarness({ env });
  closers.push(() => result.sql.close());
  const project = result.store.createSession("https://interviewer.test", {
    title: "T",
    origin: { projectKey: "github.com/o/r" },
  }).project!;
  return { ...result, project };
}

describe("GitHub client", () => {
  it("parses PRs, checks, reviews, paginated files and sends GitHub's headers", async () => {
    const github = fakeGitHub();
    github.state.pulls = [{ number: 7, title: "Add PRs", sha: "abc" }];
    github.state.checks.abc = [
      run("lint", "success", 11),
      run("deploy", null, 12, false),
    ];
    github.state.reviews[7] = [
      { user: { login: "ann" }, state: "CHANGES_REQUESTED" },
      { user: { login: "ann" }, state: "APPROVED", submitted_at: "x" },
      { user: { login: "ann" }, state: "COMMENTED" },
      { user: { login: "bob" }, state: "PENDING" },
    ];
    github.state.files[7] = Array.from({ length: 105 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1 @@\n-a\n+b",
    }));
    const client = new GitHubClient("secret", github.fetch);

    const [pull] = await client.openPulls("o/r");
    expect(pull).toMatchObject({
      number: 7,
      headRef: "branch-7",
      headSha: "abc",
      draft: false,
      author: "tim",
      additions: 70,
      deletions: 7,
      updatedAt: "2026-10-07T00:00:00Z",
    });
    expect(github.state.calls[0]!.headers).toMatchObject({
      authorization: "Bearer secret",
      "x-github-api-version": "2022-11-28",
      "user-agent": expect.stringMatching(/.+/),
    });
    expect((await client.pull("o/r", 7)).mergeableState).toBe("clean");
    expect(await client.checkRuns("o/r", "abc")).toEqual([
      expect.objectContaining({ name: "lint", jobId: 11 }),
      expect.objectContaining({ name: "deploy", jobId: null }),
    ]);
    expect(await client.reviews("o/r", 7)).toEqual([
      { author: "ann", state: "APPROVED", submittedAt: "x", url: null },
    ]);
    const files = await client.files("o/r", 7);
    expect(files).toHaveLength(105);
    expect(files[0]).toMatchObject({
      filename: "src/f0.ts",
      patch: expect.any(String),
    });
    expect(client.requests).toBe(6);
    expect(client.remaining).toBe(4999);
  });

  it("follows a job log's redirect without the token and keeps the error and the tail", async () => {
    const github = fakeGitHub();
    const lines = Array.from(
      { length: 200 },
      (_, i) =>
        `2026-10-07T00:00:${String(i % 60).padStart(2, "0")}.1234567Z line ${i}`,
    );
    lines[20] =
      "2026-10-07T00:00:00.0Z ##[error]src/hub.ts(236,9): error TS2339";
    github.state.logs[99] = lines.join("\n") + "\n";
    const client = new GitHubClient("secret", github.fetch);

    const log = await client.jobLog("o/r", 99);
    expect(log.tail).toHaveLength(60);
    expect(log.tail.at(-1)).toBe("line 199");
    expect(log.around![5]).toBe("##[error]src/hub.ts(236,9): error TS2339");
    expect(log.around![0]).toBe("line 15");
    const blob = github.state.calls.find((call) => call.url.includes("blob"));
    expect(blob!.headers.authorization).toBeUndefined();
  });

  it("leaves out the error window when the error is already in the tail", () => {
    expect(logExcerpt("a\nerror here\nb\n")).toEqual({
      around: null,
      tail: ["a", "error here", "b"],
    });
  });

  it("rolls checks up: failing beats running beats passing", () => {
    const check = (status: string, conclusion: string | null) => ({
      status,
      conclusion,
    });
    expect(rollUp([]).ci).toBe("none");
    expect(
      rollUp([check("completed", "success"), check("completed", "skipped")]).ci,
    ).toBe("green");
    expect(
      rollUp([check("completed", "success"), check("queued", null)]).ci,
    ).toBe("pending");
    expect(
      rollUp([check("queued", null), check("completed", "failure")]),
    ).toEqual({
      ci: "red",
      failingIndexes: [1],
    });
  });
});

describe("ready to merge", () => {
  const pull = { draft: false, mergeable: true, mergeableState: "clean" };
  it("follows GitHub's mergeable state, never with failing checks or changes requested", () => {
    expect(isReady(pull, "green", [])).toBe(true);
    expect(isReady(pull, "none", [])).toBe(true);
    expect(isReady({ ...pull, draft: true }, "green", [])).toBe(false);
    expect(isReady(pull, "red", [])).toBe(false);
    expect(isReady(pull, "pending", [])).toBe(false);
    expect(isReady(pull, "green", [{ state: "CHANGES_REQUESTED" }])).toBe(
      false,
    );
    for (const state of ["blocked", "behind", "dirty", "unstable"])
      expect(isReady({ ...pull, mergeableState: state }, "green", [])).toBe(
        false,
      );
    // Still computing: our own reading of the checks stands in.
    expect(isReady({ ...pull, mergeableState: "unknown" }, "green", [])).toBe(
      true,
    );
    expect(isReady({ ...pull, mergeableState: null }, "none", [])).toBe(false);
  });

  it("only knows repos keyed github.com/owner/repo", () => {
    expect(repoOf("github.com/o/r")).toBe("o/r");
    expect(repoOf("gitlab.com/o/r")).toBeNull();
    expect(repoOf("local/thing")).toBeNull();
  });

  it("labels a row by its most pressing state", () => {
    const pr = {
      state: "open" as const,
      draft: false,
      ready: false,
      ci: "green" as const,
    };
    expect(prLabel({ ...pr, draft: true })).toBe("Draft");
    expect(prLabel({ ...pr, ci: "red" })).toBe("CI failed");
    expect(prLabel({ ...pr, ready: true })).toBe("Ready");
    expect(prLabel({ ...pr, ci: "pending" })).toBe("Pending");
  });
});

describe("patch hunks", () => {
  it("numbers old and new lines across hunks", () => {
    const hunks = parsePatch(
      [
        "@@ -1,3 +1,4 @@ function main() {",
        " keep",
        "-old",
        "+new",
        "+added",
        " end",
        "@@ -10 +11,0 @@",
        "-gone",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({
      oldStart: 1,
      newStart: 1,
      section: "function main() {",
    });
    expect(hunks[0]!.lines).toEqual([
      { kind: "ctx", text: "keep", oldNo: 1, newNo: 1 },
      { kind: "del", text: "old", oldNo: 2, newNo: null },
      { kind: "add", text: "new", oldNo: null, newNo: 2 },
      { kind: "add", text: "added", oldNo: null, newNo: 3 },
      { kind: "ctx", text: "end", oldNo: 3, newNo: 4 },
    ]);
    expect(hunks[1]!.lines).toEqual([
      { kind: "del", text: "gone", oldNo: 10, newNo: null },
      {
        kind: "note",
        text: "\\ No newline at end of file",
        oldNo: null,
        newNo: null,
      },
    ]);
  });

  it("groups files by directory for the tree", () => {
    expect(
      groupByDirectory([
        { filename: "src/b.ts" },
        { filename: "README.md" },
        { filename: "src/a.ts" },
      ]),
    ).toEqual([
      { dir: "", files: [{ filename: "README.md" }] },
      {
        dir: "src",
        files: [{ filename: "src/a.ts" }, { filename: "src/b.ts" }],
      },
    ]);
  });
});

describe("PR sync", () => {
  it("refuses with setup guidance when no token is set", async () => {
    const { app, project } = harness({});
    for (const [method, url] of [
      ["GET", `/api/browser/kim/projects/${project.id}/prs`],
      ["POST", `/api/browser/kim/projects/${project.id}/prs/sync`],
      ["GET", `/api/browser/kim/projects/${project.id}/prs/3`],
      ["GET", "/api/sessions/kim/prs?project=github.com/o/r"],
    ]) {
      const response = await app.inject({ method: method!, url: url! });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "GITHUB_TOKEN not set" });
    }
  });

  it("syncs open PRs on the timer, tracks CI and readiness, and drops closed PRs", async () => {
    const github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetch);
    const { app, hub, project } = harness();
    github.state.pulls = [
      { number: 1, title: "Ready one", sha: "s1" },
      { number: 2, title: "Broken one", sha: "s2" },
      {
        number: 3,
        title: "Draft one",
        sha: "s3",
        draft: true,
        mergeable_state: "draft",
      },
    ];
    github.state.checks.s1 = [run("test", "success", 1)];
    github.state.checks.s2 = [
      run("lint", "success", 2),
      run("typecheck", "failure", 3),
    ];
    github.state.checks.s3 = [run("test", null, 4)];
    const t0 = Date.parse("2026-10-07T01:00:00Z");

    await hub.tick(t0);
    const list = (
      await app.inject({
        method: "GET",
        url: `/api/browser/kim/projects/${project.id}/prs`,
      })
    ).json();
    expect(list.repo).toBe("o/r");
    expect(list.prs.map((pr: { number: number }) => pr.number).sort()).toEqual([
      1, 2, 3,
    ]);
    const byNumber = (n: number) =>
      list.prs.find((pr: { number: number }) => pr.number === n);
    expect(byNumber(1)).toMatchObject({
      ci: "green",
      ready: true,
      readySince: "2026-10-07T01:00:00.000Z",
    });
    expect(byNumber(2)).toMatchObject({
      ci: "red",
      ready: false,
      failing: ["typecheck"],
      ciFailedSince: "2026-10-07T01:00:00.000Z",
      additions: 20,
      headRef: "branch-2",
    });
    expect(byNumber(3)).toMatchObject({
      ci: "pending",
      draft: true,
      ready: false,
    });

    const inbox = (
      await app.inject({ method: "GET", url: "/api/browser/kim/inbox" })
    ).json().items;
    expect(inbox).toEqual([
      expect.objectContaining({
        id: "ci_failed:github.com/o/r#2",
        kind: "ci_failed",
        projectId: project.id,
        since: "2026-10-07T01:00:00.000Z",
        brief: expect.stringContaining("typecheck"),
        data: {
          projectId: project.id,
          number: 2,
          url: "https://github.com/o/r/pull/2",
          failing: ["typecheck"],
        },
      }),
      expect.objectContaining({
        id: "prs_ready:github.com/o/r",
        kind: "prs_ready",
        data: expect.objectContaining({ numbers: [1] }),
      }),
    ]);
    const projects = (
      await app.inject({ method: "GET", url: "/api/browser/kim/projects" })
    ).json().projects;
    expect(projects[0].stats).toMatchObject({
      openPrs: 3,
      ci: "red",
      needsYou: 2,
    });

    // Under two minutes later the project isn't polled again.
    const calls = github.fetch.mock.calls.length;
    await hub.tick(t0 + 60_000);
    expect(github.fetch.mock.calls.length).toBe(calls);

    // A fix lands on #2, #1 merges, and the draft's checks pass.
    github.state.pulls[1] = {
      number: 2,
      title: "Broken one",
      sha: "s2b",
      updated_at: "2026-10-07T02:00:00Z",
    };
    github.state.checks.s2b = [
      run("lint", "success", 5),
      run("typecheck", "success", 6),
    ];
    github.state.checks.s3 = [run("test", "success", 4)];
    github.close(1, true);
    await hub.tick(t0 + 3 * 60_000);

    const after = (
      await app.inject({
        method: "GET",
        url: "/api/sessions/kim/prs?project=github.com/o/r",
      })
    ).json();
    expect(after.prs.map((pr: { number: number }) => pr.number).sort()).toEqual(
      [2, 3],
    );
    expect(
      after.prs.find((pr: { number: number }) => pr.number === 2),
    ).toMatchObject({
      ci: "green",
      ciFailedSince: null,
      ready: true,
      readySince: "2026-10-07T01:03:00.000Z",
    });
    const merged = hub.inbox();
    expect(merged.map((item) => item.id)).toEqual(["prs_ready:github.com/o/r"]);
    expect(merged[0]!.since).toBe("2026-10-07T01:03:00.000Z");
    expect(merged[0]!.data).toMatchObject({ numbers: [2] });
    const stats = (
      await app.inject({ method: "GET", url: "/api/browser/kim/projects" })
    ).json().projects[0].stats;
    // The draft's checks don't count towards the project's CI.
    expect(stats).toMatchObject({ openPrs: 2, ci: "green" });
  });

  it("stays within its request budget and catches up on the next sync", async () => {
    const github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetch);
    const { hub, sql } = harness();
    github.state.pulls = Array.from({ length: 20 }, (_, i) => ({
      number: i + 1,
      title: `PR ${i + 1}`,
      sha: `sha${i + 1}`,
    }));
    for (let i = 1; i <= 20; i++)
      github.state.checks[`sha${i}`] = [run("test", "success", i)];
    const t0 = Date.parse("2026-10-07T01:00:00Z");

    await hub.tick(t0);
    expect(github.fetch.mock.calls.length).toBeLessThanOrEqual(40);
    const rows = () => sql.all("SELECT number, ci FROM prs");
    // Every PR shows up; those past the budget wait for their checks.
    expect(rows()).toHaveLength(20);
    expect(rows().filter((row) => row.ci === "none").length).toBeGreaterThan(0);

    await hub.tick(t0 + 3 * 60_000);
    expect(rows().every((row) => row.ci === "green")).toBe(true);
  });

  it("keeps a failure's start time while it stays red, and clears it once green", async () => {
    const github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetch);
    const { hub } = harness();
    github.state.pulls = [{ number: 4, title: "Flaky", sha: "a" }];
    github.state.checks.a = [run("test", "failure", 1)];
    const t0 = Date.parse("2026-10-07T01:00:00Z");
    await hub.tick(t0);
    // A new push, still failing: the item keeps its place in the inbox.
    github.state.pulls[0] = {
      number: 4,
      title: "Flaky",
      sha: "b",
      updated_at: "2026-10-07T01:01:00Z",
    };
    github.state.checks.b = [run("test", "failure", 2)];
    await hub.tick(t0 + 3 * 60_000);
    expect(hub.inbox()[0]!.since).toBe("2026-10-07T01:00:00.000Z");
    github.state.checks.b = [run("test", null, 3)];
    await hub.tick(t0 + 6 * 60_000);
    expect(hub.inbox()).toEqual([]);
  });

  it("syncs now and serves live detail with the failing job's log", async () => {
    const github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetch);
    const { app, project } = harness();
    github.state.pulls = [{ number: 9, title: "Lease", sha: "z" }];
    github.state.checks.z = [
      run("typecheck", "failure", 77),
      run("lint", "success", 78),
    ];
    github.state.reviews[9] = [{ user: { login: "ann" }, state: "APPROVED" }];
    github.state.files[9] = [
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-a\n+b",
      },
    ];
    github.state.logs[77] = "setup\nerror TS2339: nope\n";

    const synced = await app.inject({
      method: "POST",
      url: `/api/browser/kim/projects/${project.id}/prs/sync`,
    });
    expect(synced.json().prs).toEqual([
      expect.objectContaining({ number: 9, ci: "red", failing: ["typecheck"] }),
    ]);

    const detail = await app.inject({
      method: "GET",
      url: `/api/browser/kim/projects/${project.id}/prs/9`,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.pr).toMatchObject({ number: 9, baseRef: "main", ci: "red" });
    expect(body.checks[0]).toMatchObject({
      name: "typecheck",
      jobId: 77,
      log: { around: null, tail: ["setup", "error TS2339: nope"] },
    });
    expect(body.checks[1].log).toBeNull();
    expect(body.reviews).toEqual([
      expect.objectContaining({ author: "ann", state: "APPROVED" }),
    ]);
    expect(body.files).toHaveLength(1);

    // Cached for a minute.
    const calls = github.fetch.mock.calls.length;
    await app.inject({
      method: "GET",
      url: `/api/browser/kim/projects/${project.id}/prs/9`,
    });
    expect(github.fetch.mock.calls.length).toBe(calls);

    const missing = await app.inject({
      method: "GET",
      url: `/api/browser/kim/projects/${project.id}/prs/404`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
