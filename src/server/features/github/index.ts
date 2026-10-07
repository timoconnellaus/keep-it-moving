import type { Context, Hono } from "hono";
import type {
  CiState,
  PrCheck,
  PrDetailResponse,
  PrListResponse,
  PrReview,
  PrSummary,
} from "../../../shared/github.js";
import type { InboxItem, ProjectStats } from "../../../shared/inbox.js";
import type { ProjectView } from "../../../shared/schema.js";
import { first, type Row } from "../../sql.js";
import type { Feature, FeatureContext } from "../types.js";
import {
  GitHubClient,
  GitHubError,
  rollUp,
  type FetchLike,
  type GhCheck,
  type GhPull,
} from "./client.js";

/** A project's PRs sync at most this often from the timer. */
const SYNC_EVERY_MS = 2 * 60_000;
/** Requests one tick may make: Workers allow 50 subrequests per alarm. */
const TICK_BUDGET = 40;
/** Requests "Sync now" may make for one project. */
const SYNC_NOW_BUDGET = 45;
/** An unchanged PR's checks and reviews are refetched this often anyway. */
const REFRESH_EVERY_MS = 15 * 60_000;
/** The PR page's live detail is cached this long. */
const DETAIL_TTL_MS = 60_000;
/** Failing Actions jobs whose logs one PR page fetches. */
const MAX_LOGS = 3;
/** Closed and merged PRs are forgotten after this long. */
const FORGET_CLOSED_MS = 30 * 24 * 60 * 60_000;
const GITHUB_PREFIX = "github.com/";

export const TOKEN_MISSING = "GITHUB_TOKEN not set";

/** owner/repo for a project keyed by a github.com remote, else null. */
export function repoOf(key: string): string | null {
  if (!key.startsWith(GITHUB_PREFIX)) return null;
  const parts = key.slice(GITHUB_PREFIX.length).split("/");
  // The repo goes into API paths: GitHub's name characters only, no "..".
  const valid =
    parts.length === 2 &&
    /^[A-Za-z0-9-]+$/.test(parts[0]!) &&
    /^[A-Za-z0-9._-]+$/.test(parts[1]!) &&
    !/^\.\.?$/.test(parts[1]!);
  return valid ? parts.join("/") : null;
}

/**
 * Whether a PR is ready to merge, following GitHub's own verdict:
 *
 * - never a draft, never with a check failing or still running, never with a
 *   reviewer's latest review asking for changes;
 * - otherwise ready when GitHub's mergeable_state is "clean" (mergeable,
 *   checks passed, required reviews met) or "has_hooks" (clean, with
 *   post-merge hooks);
 * - while GitHub is still computing it ("unknown" or missing), ready when
 *   mergeable isn't false and the checks are green.
 *
 * "blocked", "behind", "dirty", "unstable" and "draft" are not ready.
 */
export function isReady(
  pull: Pick<GhPull, "draft" | "mergeable" | "mergeableState">,
  ci: CiState,
  reviews: Pick<PrReview, "state">[],
): boolean {
  if (pull.draft || ci === "red" || ci === "pending") return false;
  if (reviews.some((review) => review.state === "CHANGES_REQUESTED"))
    return false;
  const state = pull.mergeableState;
  if (state === "clean" || state === "has_hooks") return true;
  if (state === null || state === "unknown")
    return pull.mergeable !== false && ci === "green";
  return false;
}

const CI_RANK: Record<CiState, number> = {
  none: 0,
  green: 1,
  pending: 2,
  red: 3,
};

/** PRs, CI, diffs and ready-to-merge, read from GitHub with GITHUB_TOKEN. */
export function githubFeature(
  ctx: FeatureContext,
  options: { fetch?: FetchLike } = {},
): Feature {
  const { sql, store } = ctx;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS prs (
      project_id TEXT NOT NULL, number INTEGER NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, head_ref TEXT NOT NULL, head_sha TEXT NOT NULL,
      draft INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL,
      additions INTEGER NOT NULL DEFAULT 0, deletions INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'open', ci TEXT NOT NULL DEFAULT 'none',
      checks TEXT NOT NULL DEFAULT '[]', mergeable_state TEXT,
      ready INTEGER NOT NULL DEFAULT 0, failing TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL, synced_at TEXT NOT NULL,
      ci_failed_since TEXT, ready_since TEXT,
      refreshed_key TEXT NOT NULL DEFAULT '', refreshed_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, number)
    );
    CREATE TABLE IF NOT EXISTS pr_syncs (
      project_id TEXT PRIMARY KEY, synced_at INTEGER NOT NULL, error TEXT
    );
  `);

  const token = () => ctx.env.githubToken || null;
  const client = () => new GitHubClient(token()!, options.fetch);
  /** GitHub's rate limit ran out: the timer waits until it resets. */
  let pausedUntil = 0;
  const details = new Map<string, { at: number; value: PrDetailResponse }>();

  const githubProjects = () =>
    store.listProjects().flatMap((project) => {
      const repo = repoOf(project.key);
      return repo ? [{ project, repo }] : [];
    });
  const findProject = (ref: string): ProjectView | undefined =>
    store
      .listProjects()
      .find(
        (project) =>
          project.id === ref ||
          project.key === ref ||
          project.name.toLowerCase() === ref.toLowerCase(),
      );
  const lastSync = (projectId: string) =>
    first(sql, "SELECT * FROM pr_syncs WHERE project_id = ?", projectId);
  const openRows = (projectId?: string) =>
    (projectId
      ? sql.all(
          "SELECT * FROM prs WHERE state = 'open' AND project_id = ? ORDER BY updated_at DESC",
          projectId,
        )
      : sql.all(
          "SELECT * FROM prs WHERE state = 'open' ORDER BY updated_at DESC",
        )
    ).map(mapPr);

  /** What a sync turned up that Tim should hear about. */
  interface Outcome {
    changed: boolean;
    news: boolean;
  }

  /** Writes a fully refreshed PR, keeping since-times across unchanged states. */
  const record = (
    projectId: string,
    pull: GhPull,
    checks: GhCheck[],
    reviews: PrReview[],
    now: number,
    outcome: Outcome,
  ) => {
    const iso = new Date(now).toISOString();
    const previous = first(
      sql,
      "SELECT * FROM prs WHERE project_id = ? AND number = ?",
      projectId,
      pull.number,
    );
    const { ci, failingIndexes } = rollUp(checks);
    const failing = failingIndexes.map((index) => checks[index]!.name);
    const ready = pull.state === "open" && isReady(pull, ci, reviews);
    const wasRed = previous?.ci === "red" && previous.state === "open";
    const wasReady = Boolean(previous?.ready) && previous?.state === "open";
    const ciFailedSince =
      ci === "red"
        ? wasRed && previous?.ci_failed_since
          ? String(previous.ci_failed_since)
          : iso
        : null;
    const readySince = ready
      ? wasReady && previous?.ready_since
        ? String(previous.ready_since)
        : iso
      : null;
    if ((ci === "red" && !wasRed) || (ready && !wasReady)) outcome.news = true;
    const summary: PrCheck[] = checks.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      url: check.url,
    }));
    const state =
      pull.state === "open" ? "open" : pull.merged ? "merged" : "closed";
    sql.all(
      `INSERT INTO prs (project_id, number, title, url, head_ref, head_sha, draft, author,
         additions, deletions, state, ci, checks, mergeable_state, ready, failing,
         updated_at, synced_at, ci_failed_since, ready_since, refreshed_key, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, number) DO UPDATE SET
         title = excluded.title, url = excluded.url, head_ref = excluded.head_ref,
         head_sha = excluded.head_sha, draft = excluded.draft, author = excluded.author,
         additions = excluded.additions, deletions = excluded.deletions, state = excluded.state,
         ci = excluded.ci, checks = excluded.checks, mergeable_state = excluded.mergeable_state,
         ready = excluded.ready, failing = excluded.failing, updated_at = excluded.updated_at,
         synced_at = excluded.synced_at, ci_failed_since = excluded.ci_failed_since,
         ready_since = excluded.ready_since, refreshed_key = excluded.refreshed_key,
         refreshed_at = excluded.refreshed_at`,
      projectId,
      pull.number,
      pull.title,
      pull.url,
      pull.headRef,
      pull.headSha,
      pull.draft ? 1 : 0,
      pull.author,
      pull.additions ?? Number(previous?.additions ?? 0),
      pull.deletions ?? Number(previous?.deletions ?? 0),
      state,
      ci,
      JSON.stringify(summary),
      pull.mergeableState,
      ready ? 1 : 0,
      JSON.stringify(failing),
      pull.updatedAt,
      iso,
      ciFailedSince,
      readySince,
      refreshKey(pull),
      now,
    );
    if (
      !previous ||
      previous.ci !== ci ||
      Boolean(previous.ready) !== ready ||
      previous.state !== state ||
      previous.updated_at !== pull.updatedAt ||
      previous.checks !== JSON.stringify(summary)
    )
      outcome.changed = true;
  };

  /**
   * Brings one project's PRs up to date within a request budget. A PR whose
   * head and update time haven't moved, with passing checks and a known
   * mergeable state, is only refetched every REFRESH_EVERY_MS; PRs the
   * budget can't reach keep their old data and go first next time.
   */
  const syncProject = async (
    projectId: string,
    repo: string,
    github: GitHubClient,
    budget: number,
    now: number,
    outcome: Outcome,
  ) => {
    try {
      const pulls = await github.openPulls(repo);
      const known = new Map(
        sql
          .all("SELECT * FROM prs WHERE project_id = ?", projectId)
          .map((row) => [Number(row.number), row]),
      );
      const open = new Set(pulls.map((pull) => pull.number));
      const stale = (pull: GhPull) => {
        const row = known.get(pull.number);
        return (
          !row ||
          row.state !== "open" ||
          row.refreshed_key !== refreshKey(pull) ||
          row.ci === "pending" ||
          // A failed check can be re-run on the same commit.
          row.ci === "red" ||
          !row.mergeable_state ||
          row.mergeable_state === "unknown" ||
          now - Number(row.refreshed_at) > REFRESH_EVERY_MS
        );
      };
      // Never-seen and longest-unrefreshed first.
      const queue = pulls
        .filter(stale)
        .sort(
          (a, b) =>
            Number(known.get(a.number)?.refreshed_at ?? 0) -
            Number(known.get(b.number)?.refreshed_at ?? 0),
        );
      for (const pull of queue) {
        if (github.requests + 3 > budget) {
          // Out of budget: a new PR still shows up, without its checks yet.
          if (
            !known.has(pull.number) ||
            known.get(pull.number)!.state !== "open"
          )
            record(
              projectId,
              { ...pull, mergeableState: null },
              [],
              [],
              now,
              outcome,
            );
          continue;
        }
        const [detail, checks, reviews] = await Promise.all([
          github.pull(repo, pull.number),
          github.checkRuns(repo, pull.headSha),
          github.reviews(repo, pull.number),
        ]);
        record(projectId, detail, checks, reviews, now, outcome);
      }
      for (const [number, row] of known) {
        if (row.state !== "open" || open.has(number)) continue;
        // Merged or just closed; a PR GitHub no longer shows counts as closed.
        let state = "closed";
        if (github.requests < budget)
          state = (await github.pull(repo, number).catch(() => null))?.merged
            ? "merged"
            : "closed";
        sql.all(
          `UPDATE prs SET state = ?, ready = 0, ready_since = NULL, ci_failed_since = NULL,
             synced_at = ? WHERE project_id = ? AND number = ?`,
          state,
          new Date(now).toISOString(),
          projectId,
          number,
        );
        outcome.changed = true;
      }
      sql.all(
        "DELETE FROM prs WHERE project_id = ? AND state != 'open' AND synced_at < ?",
        projectId,
        new Date(now - FORGET_CLOSED_MS).toISOString(),
      );
      setSynced(projectId, now, null);
    } catch (error) {
      setSynced(projectId, now, message(error));
      if (error instanceof GitHubError && error.rateLimited)
        pausedUntil = error.resetAt ?? now + 15 * 60_000;
      throw error;
    } finally {
      // Running low: let the hourly allowance recover before polling again.
      if (github.remaining !== null && github.remaining < 50)
        pausedUntil = Math.max(
          pausedUntil,
          github.resetAt ?? now + 15 * 60_000,
        );
    }
  };
  const setSynced = (projectId: string, now: number, error: string | null) =>
    sql.all(
      `INSERT INTO pr_syncs (project_id, synced_at, error) VALUES (?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET synced_at = excluded.synced_at, error = excluded.error`,
      projectId,
      now,
      error,
    );
  const announce = (outcome: Outcome) => {
    if (outcome.changed) ctx.changed();
    if (outcome.news) ctx.notify();
  };

  const listResponse = (project: ProjectView): PrListResponse => {
    const sync = lastSync(project.id);
    return {
      repo: repoOf(project.key),
      prs: openRows(project.id),
      syncedAt: sync ? new Date(Number(sync.synced_at)).toISOString() : null,
      error: sync?.error ? String(sync.error) : null,
    };
  };

  /** Everything the PR page shows, live from GitHub. */
  const detail = async (
    project: ProjectView,
    repo: string,
    number: number,
  ): Promise<PrDetailResponse> => {
    const github = client();
    const pull = await github.pull(repo, number);
    const [checks, reviews, files] = await Promise.all([
      github.checkRuns(repo, pull.headSha),
      github.reviews(repo, number),
      github.files(repo, number),
    ]);
    const { failingIndexes } = rollUp(checks);
    const logged = new Set(
      failingIndexes.filter((index) => checks[index]!.jobId).slice(0, MAX_LOGS),
    );
    const logs = await Promise.all(
      checks.map((check, index) =>
        logged.has(index)
          ? github.jobLog(repo, check.jobId!).catch(() => null)
          : null,
      ),
    );
    const now = Date.now();
    const outcome = { changed: false, news: false };
    record(project.id, pull, checks, reviews, now, outcome);
    announce(outcome);
    const row = first(
      sql,
      "SELECT * FROM prs WHERE project_id = ? AND number = ?",
      project.id,
      number,
    )!;
    return {
      repo,
      pr: {
        ...mapPr(row),
        body: pull.body,
        baseRef: pull.baseRef,
        merged: pull.merged,
      },
      checks: checks.map((check, index) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        url: check.url,
        jobId: check.jobId,
        log: logs[index] ?? null,
      })),
      reviews,
      files,
      filesTruncated: files.length >= 300,
      fetchedAt: new Date(now).toISOString(),
    };
  };

  /** Runs a route that needs the token and a project, mapping GitHub failures to statuses. */
  const guarded =
    (
      handler: (
        c: Context,
        project: ProjectView,
      ) => Promise<Response> | Response,
    ) =>
    async (c: Context) => {
      if (!token()) return c.json({ error: TOKEN_MISSING }, 503);
      const project = findProject(c.req.param("id") ?? "");
      if (!project) return c.json({ error: "Project not found" }, 404);
      try {
        return await handler(c, project);
      } catch (error) {
        const status =
          error instanceof GitHubError
            ? error.status === 404
              ? 404
              : error.rateLimited
                ? 429
                : 502
            : 500;
        return c.json({ error: message(error) }, status);
      }
    };

  return {
    name: "github",

    agentRoutes(app: Hono) {
      // The CLI's `pr list`: one project's open PRs, or every project's.
      app.get("/prs", (c) => {
        if (!token()) return c.json({ error: TOKEN_MISSING }, 503);
        const ref = c.req.query("project");
        if (!ref) return c.json({ prs: openRows() });
        const project = findProject(ref);
        if (!project) return c.json({ error: "Project not found" }, 404);
        return c.json({ project, ...listResponse(project) });
      });
    },

    browserRoutes(app: Hono) {
      app.get(
        "/projects/:id/prs",
        guarded((c, project) => c.json(listResponse(project))),
      );
      app.post(
        "/projects/:id/prs/sync",
        guarded(async (c, project) => {
          const repo = repoOf(project.key);
          if (!repo)
            return c.json({ error: "This project has no GitHub repo" }, 400);
          const outcome = { changed: false, news: false };
          for (const key of details.keys())
            if (key.startsWith(`${project.id}#`)) details.delete(key);
          await syncProject(
            project.id,
            repo,
            client(),
            SYNC_NOW_BUDGET,
            Date.now(),
            outcome,
          );
          announce(outcome);
          return c.json(listResponse(project));
        }),
      );
      app.get(
        "/projects/:id/prs/:number",
        guarded(async (c, project) => {
          const repo = repoOf(project.key);
          if (!repo)
            return c.json({ error: "This project has no GitHub repo" }, 400);
          const number = Number(c.req.param("number"));
          if (!Number.isInteger(number) || number <= 0)
            return c.json({ error: "Not a PR number" }, 400);
          const key = `${project.id}#${number}`;
          const cached = details.get(key);
          if (cached && Date.now() - cached.at < DETAIL_TTL_MS)
            return c.json(cached.value);
          const value = await detail(project, repo, number);
          details.set(key, { at: Date.now(), value });
          return c.json(value);
        }),
      );
    },

    inbox(): InboxItem[] {
      const names = new Map(
        store.listProjects().map((project) => [project.id, project]),
      );
      const rows = openRows();
      const items: InboxItem[] = [];
      for (const pr of rows) {
        if (pr.ci !== "red") continue;
        const project = names.get(pr.projectId);
        const checks =
          pr.failing.length === 1
            ? `${pr.failing[0]} is failing`
            : `${pr.failing.length} checks are failing: ${pr.failing.join(", ")}`;
        items.push({
          id: `ci_failed:${project?.key ?? pr.projectId}#${pr.number}`,
          kind: "ci_failed",
          projectId: pr.projectId,
          title: `CI failed on #${pr.number} ${pr.title}`,
          brief: `${checks} on ${pr.headRef}.`,
          source: `PR #${pr.number} · ${pr.headRef} · ${pr.author}`,
          since: pr.ciFailedSince ?? pr.syncedAt,
          data: {
            projectId: pr.projectId,
            number: pr.number,
            url: pr.url,
            failing: pr.failing,
          },
        });
      }
      const ready = new Map<string, PrSummary[]>();
      for (const pr of rows)
        if (pr.ready)
          ready.set(pr.projectId, [...(ready.get(pr.projectId) ?? []), pr]);
      for (const [projectId, prs] of ready) {
        const project = names.get(projectId);
        prs.sort((a, b) => a.number - b.number);
        const since = prs.map((pr) => pr.readySince ?? pr.syncedAt).sort()[0]!;
        items.push({
          id: `prs_ready:${project?.key ?? projectId}`,
          kind: "prs_ready",
          projectId,
          title:
            prs.length === 1
              ? `#${prs[0]!.number} ${prs[0]!.title} is ready to merge`
              : `${prs.length} PRs ready to merge`,
          brief: `${prs.map((pr) => `#${pr.number}`).join(", ")} ${prs.length === 1 ? "is" : "are"} mergeable with checks green and reviews met.`,
          source: "GitHub: mergeable, green, reviews met",
          since,
          data: {
            numbers: prs.map((pr) => pr.number),
            prs: prs.map((pr) => ({
              number: pr.number,
              title: pr.title,
              url: pr.url,
              additions: pr.additions,
              deletions: pr.deletions,
              headRef: pr.headRef,
            })),
          },
        });
      }
      return items;
    },

    projectStats(): Record<string, ProjectStats> {
      const stats: Record<string, ProjectStats> = {};
      for (const { project } of githubProjects())
        if (lastSync(project.id)) stats[project.id] = { openPrs: 0, ci: null };
      for (const pr of openRows()) {
        const entry = (stats[pr.projectId] ??= { openPrs: 0, ci: null });
        entry.openPrs = (entry.openPrs ?? 0) + 1;
        if (pr.draft || pr.ci === "none") continue;
        if (!entry.ci || CI_RANK[pr.ci] > CI_RANK[entry.ci]) entry.ci = pr.ci;
      }
      return stats;
    },

    async tick(now: number) {
      if (!token() || now < pausedUntil) return;
      const github = client();
      const outcome = { changed: false, news: false };
      const due = githubProjects()
        .map(({ project, repo }) => ({
          project,
          repo,
          at: Number(lastSync(project.id)?.synced_at ?? 0),
        }))
        .filter(({ at }) => now - at >= SYNC_EVERY_MS)
        .sort((a, b) => a.at - b.at);
      for (const { project, repo } of due) {
        // Listing a repo's PRs takes one or two requests.
        if (github.requests + 2 > TICK_BUDGET || now < pausedUntil) break;
        try {
          await syncProject(
            project.id,
            repo,
            github,
            TICK_BUDGET,
            now,
            outcome,
          );
        } catch (error) {
          console.error(`github sync ${project.key}`, message(error));
        }
      }
      announce(outcome);
    },
  };
}

/** A PR changed when its head or its update time moved. */
const refreshKey = (pull: GhPull) => `${pull.updatedAt}|${pull.headSha}`;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function mapPr(row: Row): PrSummary {
  return {
    projectId: String(row.project_id),
    number: Number(row.number),
    title: String(row.title),
    url: String(row.url),
    headRef: String(row.head_ref),
    headSha: String(row.head_sha),
    draft: Boolean(row.draft),
    author: String(row.author),
    additions: Number(row.additions),
    deletions: Number(row.deletions),
    state: String(row.state) as PrSummary["state"],
    ci: String(row.ci) as CiState,
    checks: JSON.parse(String(row.checks)) as PrCheck[],
    mergeableState:
      row.mergeable_state === null ? null : String(row.mergeable_state),
    ready: Boolean(row.ready),
    failing: JSON.parse(String(row.failing)) as string[],
    updatedAt: String(row.updated_at),
    syncedAt: String(row.synced_at),
    ciFailedSince:
      row.ci_failed_since === null ? null : String(row.ci_failed_since),
    readySince: row.ready_since === null ? null : String(row.ready_since),
  };
}
