import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  backlogSources,
  BacklogMilestoneInputSchema,
  BacklogSyncOutputSchema,
  FollowUpActionSchema,
  FollowUpsInputSchema,
  type BacklogItemView,
  type BacklogSettingsView,
  type BacklogSource,
  type BacklogStatus,
  type BacklogSyncOutput,
  type FollowUpState,
  type FollowUpView,
  type MilestoneView,
  type ProjectBacklogView,
} from "../../shared/backlog.js";
import type { InboxItem, ProjectStats } from "../../shared/inbox.js";
import { first, type Row } from "../sql.js";
import {
  compareOrder,
  createGithubIssue,
  fetchGithubBacklog,
  githubClient,
  githubRepo,
  type Fetch,
} from "./backlogGithub.js";
import type { Feature, FeatureContext } from "./types.js";

/** Background GitHub syncs revisit a project at most this often. */
const SYNC_INTERVAL_MS = 15 * 60 * 1000;
/** The project page lists this many items under "Up next". */
const UP_NEXT_LIMIT = 20;
/** A project's summary context lists this many todo items. */
const CONTEXT_UP_NEXT = 10;
const SCRIPT_LIMIT = 200_000;

const now = () => new Date().toISOString();
const optional = (value: unknown) =>
  value === null || value === undefined ? null : String(value);

interface ProjectRow {
  id: string;
  key: string;
  name: string;
}

interface Settings extends BacklogSettingsView {
  script: string | null;
}

/**
 * Backlog, milestones and follow-ups. GitHub Issues sync runs here on the
 * server; other sources run a per-project script through the CLI, which
 * posts its output back. Follow-ups are what finished sessions left undone.
 */
export function backlogFeature(
  ctx: FeatureContext,
  deps: { fetch?: Fetch } = {},
): Feature {
  const { sql, store } = ctx;
  const fetcher: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  sql.exec(`
    CREATE TABLE IF NOT EXISTS backlog_settings (
      project_id TEXT PRIMARY KEY, source TEXT, script TEXT, auto_write INTEGER NOT NULL DEFAULT 0,
      milestone_override TEXT, synced_at TEXT, sync_error TEXT, attempted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS backlog_items (
      project_id TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      url TEXT, milestone TEXT, priority REAL, ord REAL, assignee TEXT, labels TEXT NOT NULL DEFAULT '[]',
      body TEXT, origin TEXT NOT NULL DEFAULT 'source', updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, source_id)
    );
    CREATE TABLE IF NOT EXISTS milestones (
      project_id TEXT NOT NULL, source_id TEXT NOT NULL, name TEXT NOT NULL, due TEXT, url TEXT,
      manual INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project_id, source_id)
    );
    CREATE TABLE IF NOT EXISTS follow_ups (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_session_id TEXT, text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open', backlog_source_id TEXT, created_at TEXT NOT NULL, decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS follow_ups_project ON follow_ups(project_id, state);
  `);

  const projectById = (id: string): ProjectRow => {
    const row = first(
      sql,
      "SELECT id, key, name FROM projects WHERE id = ?",
      id,
    );
    if (!row) throw new Error("Project not found");
    return mapProject(row);
  };
  const projectByKey = (key: unknown): ProjectRow => {
    if (typeof key !== "string" || !key.trim())
      throw new Error("project is required (its key, e.g. github.com/o/r)");
    return store.projectForKey(key.trim());
  };

  // Settings ------------------------------------------------------------

  /** GitHub for a github.com project once a token is set, until configured. */
  const defaultSource = (project: ProjectRow): BacklogSource =>
    githubRepo(project.key) && ctx.env.githubToken ? "github" : "none";
  const settingsFor = (project: ProjectRow): Settings => {
    const row = first(
      sql,
      "SELECT * FROM backlog_settings WHERE project_id = ?",
      project.id,
    );
    const source = optional(row?.source) as BacklogSource | null;
    return {
      source: source ?? defaultSource(project),
      configured: source !== null,
      script: optional(row?.script),
      hasScript: Boolean(row?.script),
      autoWrite: Boolean(row?.auto_write),
      milestoneOverride: optional(row?.milestone_override),
      syncedAt: optional(row?.synced_at),
      syncError: optional(row?.sync_error),
    };
  };
  const publicSettings = (settings: Settings): BacklogSettingsView => {
    const copy: Partial<Settings> = { ...settings };
    delete copy.script;
    return copy as BacklogSettingsView;
  };
  const updateSettings = (
    projectId: string,
    patch: Record<string, unknown>,
  ) => {
    sql.all(
      "INSERT OR IGNORE INTO backlog_settings (project_id) VALUES (?)",
      projectId,
    );
    for (const [column, value] of Object.entries(patch))
      sql.all(
        `UPDATE backlog_settings SET ${column} = ? WHERE project_id = ?`,
        value as string | number | null,
        projectId,
      );
  };
  const recordError = (projectId: string, error: string) => {
    updateSettings(projectId, {
      sync_error: error.slice(0, 2000),
      attempted_at: now(),
    });
    ctx.changed();
  };

  // Items and milestones -------------------------------------------------

  /**
   * Replaces a project's source items and milestones in one transaction,
   * keeping items added here. Items without the source's own order follow
   * their milestone's due date, then priority, then the order given.
   */
  const replaceSourceItems = (projectId: string, output: BacklogSyncOutput) => {
    const milestones = output.milestones ?? [];
    const due = new Map<string, string | undefined>();
    for (const milestone of milestones) {
      due.set(milestone.sourceId, milestone.due);
      due.set(milestone.name, milestone.due);
    }
    const ordered = output.items
      .map((item, index) => ({ item, index }))
      .sort((a, b) =>
        compareOrder(
          [
            a.item.order,
            due.get(a.item.milestone ?? ""),
            a.item.priority,
            a.index,
          ],
          [
            b.item.order,
            due.get(b.item.milestone ?? ""),
            b.item.priority,
            b.index,
          ],
        ),
      )
      .map(({ item }) => item);
    const time = now();
    sql.transaction(() => {
      sql.all(
        "DELETE FROM backlog_items WHERE project_id = ? AND origin = 'source'",
        projectId,
      );
      ordered.forEach((item, index) =>
        sql.all(
          `INSERT OR REPLACE INTO backlog_items (project_id, source_id, title, status, url, milestone,
            priority, ord, assignee, labels, body, origin, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'source', ?)`,
          projectId,
          item.sourceId,
          item.title,
          item.status,
          item.url ?? null,
          item.milestone ?? null,
          item.priority ?? null,
          index,
          item.assignee || null,
          JSON.stringify(item.labels ?? []),
          item.body ?? null,
          time,
        ),
      );
      // Items added here keep their own order, after the source's.
      sql
        .all(
          "SELECT source_id FROM backlog_items WHERE project_id = ? AND origin = 'local' ORDER BY ord, rowid",
          projectId,
        )
        .forEach((row, index) =>
          sql.all(
            "UPDATE backlog_items SET ord = ? WHERE project_id = ? AND source_id = ?",
            ordered.length + index,
            projectId,
            String(row.source_id),
          ),
        );
      sql.all(
        "DELETE FROM milestones WHERE project_id = ? AND manual = 0",
        projectId,
      );
      for (const milestone of milestones)
        sql.all(
          `INSERT OR REPLACE INTO milestones (project_id, source_id, name, due, url, manual)
           VALUES (?, ?, ?, ?, ?, 0)`,
          projectId,
          milestone.sourceId,
          milestone.name,
          milestone.due ?? null,
          milestone.url ?? null,
        );
      updateSettings(projectId, {
        synced_at: time,
        attempted_at: time,
        sync_error: null,
      });
    });
    ctx.changed();
    return { items: ordered.length, milestones: milestones.length };
  };

  const addItem = (
    projectId: string,
    item: {
      sourceId: string;
      title: string;
      url: string | null;
      body: string | null;
      origin: "source" | "local";
    },
  ) => {
    const next = first(
      sql,
      "SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM backlog_items WHERE project_id = ?",
      projectId,
    )!.n!;
    sql.all(
      `INSERT OR REPLACE INTO backlog_items (project_id, source_id, title, status, url, ord, labels, body,
        origin, updated_at)
       VALUES (?, ?, ?, 'todo', ?, ?, '[]', ?, ?, ?)`,
      projectId,
      item.sourceId,
      item.title,
      item.url,
      next,
      item.body,
      item.origin,
      now(),
    );
  };

  /** Every item, in progress first, then todo, done and cancelled, each in backlog order. */
  const items = (projectId: string, open = false): BacklogItemView[] =>
    sql
      .all(
        `SELECT * FROM backlog_items WHERE project_id = ?
           ${open ? "AND status IN ('in_progress', 'todo')" : ""}
         ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
           ord IS NULL, ord, rowid`,
        projectId,
      )
      .map(mapItem);

  /** Milestones with their progress, plus any items name that has no row. */
  const milestoneViews = (projectId: string): MilestoneView[] => {
    const rows = sql.all(
      "SELECT * FROM milestones WHERE project_id = ? ORDER BY due IS NULL, due, name",
      projectId,
    );
    const tagged = sql.all(
      "SELECT milestone, status FROM backlog_items WHERE project_id = ? AND milestone IS NOT NULL",
      projectId,
    );
    const views = rows.map((row): MilestoneView => ({
      sourceId: String(row.source_id),
      name: String(row.name),
      due: optional(row.due),
      url: optional(row.url),
      manual: Boolean(row.manual),
      done: 0,
      inProgress: 0,
      total: 0,
    }));
    for (const item of tagged) {
      const ref = String(item.milestone);
      let view = views.find(
        (candidate) => candidate.sourceId === ref || candidate.name === ref,
      );
      if (!view) {
        view = {
          sourceId: ref,
          name: ref,
          due: null,
          url: null,
          manual: false,
          done: 0,
          inProgress: 0,
          total: 0,
        };
        views.push(view);
      }
      count(view, item.status as BacklogStatus);
    }
    return views;
  };

  /**
   * The project's one current milestone: the override; else the nearest due
   * milestone with open items; else the one with the most open items.
   */
  const currentMilestone = (
    project: ProjectRow,
    settings = settingsFor(project),
  ): MilestoneView | null => {
    const views = milestoneViews(project.id);
    const override = settings.milestoneOverride;
    if (override)
      return (
        views.find(
          (view) => view.sourceId === override || view.name === override,
        ) ?? {
          sourceId: override,
          name: override,
          due: null,
          url: null,
          manual: true,
          done: 0,
          inProgress: 0,
          total: 0,
        }
      );
    const open = views.filter((view) => view.total - view.done > 0);
    const dated = open
      .filter((view) => view.due)
      .sort((a, b) => a.due!.localeCompare(b.due!));
    if (dated.length) return dated[0]!;
    const busiest = open.sort(
      (a, b) => b.total - b.done - (a.total - a.done),
    )[0];
    return busiest ?? null;
  };

  const counts = (projectId: string) => {
    const result = { todo: 0, inProgress: 0, done: 0, total: 0 };
    for (const row of sql.all(
      "SELECT status, COUNT(*) AS n FROM backlog_items WHERE project_id = ? GROUP BY status",
      projectId,
    )) {
      const n = Number(row.n);
      if (row.status === "todo") result.todo += n;
      if (row.status === "in_progress") result.inProgress += n;
      if (row.status === "done") result.done += n;
      if (row.status !== "cancelled") result.total += n;
    }
    return result;
  };

  const syncCommand = (project: ProjectRow) =>
    `kim backlog sync --project ${project.key}`;

  const projectView = (project: ProjectRow): ProjectBacklogView => {
    const settings = settingsFor(project);
    return {
      project,
      settings: publicSettings(settings),
      milestone: currentMilestone(project, settings),
      upNext: items(project.id, true).slice(0, UP_NEXT_LIMIT),
      counts: counts(project.id),
      syncCommand: syncCommand(project),
    };
  };

  // Sync -------------------------------------------------------------------

  const syncGithub = async (project: ProjectRow) => {
    const repo = githubRepo(project.key);
    if (!repo) throw new Error(`${project.key} is not a GitHub repository`);
    const token = ctx.env.githubToken;
    if (!token) throw new Error("GITHUB_TOKEN is not set on the Worker");
    updateSettings(project.id, { attempted_at: now() });
    try {
      const output = await fetchGithubBacklog(
        githubClient(token, fetcher),
        repo,
      );
      return replaceSourceItems(project.id, output);
    } catch (error) {
      recordError(project.id, message(error));
      throw error;
    }
  };

  // Follow-ups -------------------------------------------------------------

  const followUp = (id: string): FollowUpView => {
    const row = first(sql, "SELECT * FROM follow_ups WHERE id = ?", id);
    if (!row) throw new Error("Follow-up not found");
    return mapFollowUp(row);
  };
  const decide = (
    id: string,
    state: FollowUpState,
    backlogSourceId: string | null = null,
  ) => {
    sql.all(
      "UPDATE follow_ups SET state = ?, backlog_source_id = ?, decided_at = ? WHERE id = ?",
      state,
      backlogSourceId,
      now(),
      id,
    );
    ctx.changed();
    return followUp(id);
  };
  /** Follow-ups being accepted, so a double click opens one issue, not two. */
  const accepting = new Set<string>();

  /**
   * Puts a follow-up on the backlog. A GitHub project gets an issue (the
   * accept is Tim's go-ahead to write back); any other gets a local item.
   */
  const accept = async (id: string) => {
    const current = followUp(id);
    if (current.state === "accepted") return { followUp: current };
    if (accepting.has(id)) throw new Error("Follow-up is already being added");
    accepting.add(id);
    try {
      const project = projectById(current.projectId);
      const settings = settingsFor(project);
      const repo = githubRepo(project.key);
      const token = ctx.env.githubToken;
      const [title = current.text] = current.text.split("\n");
      let item: Parameters<typeof addItem>[1];
      if (settings.source === "github" && repo && token) {
        const issue = await createGithubIssue(
          githubClient(token, fetcher),
          repo,
          current.text,
          current.agentSessionId,
        );
        item = {
          sourceId: String(issue.number),
          title: issue.title,
          url: issue.html_url,
          body: current.text === title ? null : current.text,
          origin: "source",
        };
      } else
        item = {
          sourceId: `local-${id.slice(0, 8)}`,
          title: title.slice(0, 500),
          url: null,
          body: current.text === title ? null : current.text,
          origin: "local",
        };
      addItem(project.id, item);
      return { followUp: decide(id, "accepted", item.sourceId) };
    } finally {
      accepting.delete(id);
    }
  };

  const addFollowUps = async (input: unknown) => {
    const { projectKey, agentSessionId, items } =
      FollowUpsInputSchema.parse(input);
    const project = store.projectForKey(projectKey);
    const created: FollowUpView[] = [];
    let skipped = 0;
    for (const text of items) {
      const duplicate =
        !text ||
        first(
          sql,
          "SELECT 1 FROM follow_ups WHERE project_id = ? AND state = 'open' AND text = ?",
          project.id,
          text,
        );
      if (duplicate) {
        skipped++;
        continue;
      }
      const id = crypto.randomUUID();
      sql.all(
        `INSERT INTO follow_ups (id, project_id, agent_session_id, text, state, created_at)
         VALUES (?, ?, ?, ?, 'open', ?)`,
        id,
        project.id,
        agentSessionId ?? null,
        text,
        now(),
      );
      created.push(followUp(id));
    }
    if (created.length && settingsFor(project).autoWrite)
      for (const [index, item] of created.entries())
        try {
          created[index] = (await accept(item.id)).followUp;
        } catch (error) {
          // It stays open in the inbox for Tim to triage by hand.
          console.error("auto-accept follow-up", error);
        }
    if (created.some((item) => item.state === "open")) ctx.notify();
    if (created.length) ctx.changed();
    return { project, followUps: created, skipped };
  };

  /** Single quotes leave everything literal in a POSIX shell. */
  const followUpCommand = (text: string) =>
    `claude '${text.replace(/'/g, "'\\''")}'`;

  // Routes -----------------------------------------------------------------

  const body = async (c: Context): Promise<Record<string, unknown>> =>
    ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  const agentRoutes = (app: Hono) => {
    app.get("/backlog", (c) => {
      const project = projectByKey(c.req.query("project"));
      const settings = settingsFor(project);
      return c.json({
        project,
        settings,
        milestone: currentMilestone(project, settings),
        milestones: milestoneViews(project.id),
        items: items(project.id),
        counts: counts(project.id),
      });
    });
    app.post("/backlog/settings", async (c) => {
      const input = SettingsInputSchema.parse(await body(c));
      const project = projectByKey(input.project);
      const patch: Record<string, unknown> = {};
      if (input.source !== undefined) patch.source = input.source;
      if (input.script !== undefined) patch.script = input.script;
      if (input.autoWrite !== undefined)
        patch.auto_write = input.autoWrite ? 1 : 0;
      if (input.milestone !== undefined)
        patch.milestone_override = input.milestone?.trim() || null;
      updateSettings(project.id, patch);
      ctx.changed();
      const settings = settingsFor(project);
      return c.json({
        project,
        settings: publicSettings(settings),
        milestone: currentMilestone(project, settings),
      });
    });
    app.post("/backlog/sync", async (c) => {
      const project = projectByKey((await body(c)).project);
      const settings = settingsFor(project);
      if (settings.source === "script") {
        if (!settings.script)
          throw new Error(
            "No sync script saved; save one with `kim backlog script set --file <path>`",
          );
        return c.json({ project, script: settings.script });
      }
      if (settings.source === "none")
        throw new Error(
          "This project has no backlog source; set one with `kim backlog source github|script`",
        );
      const synced = await syncGithub(project);
      return c.json({ ...projectView(project), synced });
    });
    app.post("/backlog/items", async (c) => {
      const input = await body(c);
      const project = projectByKey(input.project);
      const parsed = BacklogSyncOutputSchema.safeParse(input.output);
      if (!parsed.success) {
        const error = `The sync script's output doesn't match the backlog shape:\n${z.prettifyError(parsed.error)}`;
        recordError(project.id, error);
        throw new Error(error);
      }
      const synced = replaceSourceItems(project.id, parsed.data);
      return c.json({
        project,
        synced,
        syncedAt: settingsFor(project).syncedAt,
      });
    });
    app.post("/backlog/error", async (c) => {
      const input = await body(c);
      const project = projectByKey(input.project);
      recordError(project.id, String(input.error ?? "Sync failed"));
      return c.json({ ok: true });
    });
    app.post("/backlog/milestones", async (c) => {
      const input = await body(c);
      const project = projectByKey(input.project);
      const milestone = BacklogMilestoneInputSchema.parse({
        sourceId: input.sourceId ?? input.name,
        name: input.name,
        due: input.due,
        url: input.url,
      });
      sql.all(
        `INSERT OR REPLACE INTO milestones (project_id, source_id, name, due, url, manual)
         VALUES (?, ?, ?, ?, ?, 1)`,
        project.id,
        milestone.sourceId,
        milestone.name,
        milestone.due ?? null,
        milestone.url ?? null,
      );
      ctx.changed();
      return c.json({
        project,
        milestone: milestoneViews(project.id).find(
          (view) => view.sourceId === milestone.sourceId,
        ),
      });
    });
    // The contract `kim report --follow-up` posts to.
    app.post("/followups", async (c) =>
      c.json(await addFollowUps(await body(c))),
    );
  };

  const browserRoutes = (app: Hono) => {
    app.get("/projects/:id/backlog", (c) =>
      c.json(projectView(projectById(c.req.param("id")))),
    );
    app.post("/projects/:id/backlog/sync", async (c) => {
      const project = projectById(c.req.param("id"));
      const settings = settingsFor(project);
      if (settings.source !== "github")
        return c.json(
          {
            error:
              settings.source === "script"
                ? "This project syncs with a script on your machine; run the command."
                : "This project has no backlog source yet.",
            command:
              settings.source === "script"
                ? syncCommand(project)
                : `kim backlog source github --project ${project.key}`,
          },
          409,
        );
      try {
        await syncGithub(project);
      } catch (error) {
        return c.json({ error: message(error) }, 502);
      }
      return c.json(projectView(project));
    });
    app.get("/projects/:id/followups", (c) => {
      const project = projectById(c.req.param("id"));
      const state = c.req.query("state") ?? "open";
      return c.json({
        followUps: sql
          .all(
            "SELECT * FROM follow_ups WHERE project_id = ? AND (? = 'all' OR state = ?) ORDER BY created_at",
            project.id,
            state,
            state,
          )
          .map(mapFollowUp),
      });
    });
    app.post("/followups/:id", async (c) => {
      const id = c.req.param("id");
      const { action } = FollowUpActionSchema.parse(await body(c));
      if (action === "accept") return c.json(await accept(id));
      const current = followUp(id);
      if (action === "dismiss")
        return c.json({ followUp: decide(id, "dismissed") });
      return c.json({
        followUp: decide(id, "started"),
        command: followUpCommand(current.text),
      });
    });
  };

  // Inbox, rail and timer ----------------------------------------------

  const inbox = (): InboxItem[] => {
    const byProject = new Map<string, FollowUpView[]>();
    for (const row of sql.all(
      "SELECT * FROM follow_ups WHERE state = 'open' ORDER BY created_at, rowid",
    )) {
      const view = mapFollowUp(row);
      byProject.set(view.projectId, [
        ...(byProject.get(view.projectId) ?? []),
        view,
      ]);
    }
    return [...byProject].map(([projectId, followUps]) => {
      const listed = followUps.slice(0, 3).map((item) => item.text);
      const more = followUps.length - listed.length;
      const sessions = new Set(followUps.map((item) => item.agentSessionId));
      const [only] = sessions;
      return {
        id: `follow_ups:${projectId}`,
        kind: "follow_ups",
        projectId,
        title: `${followUps.length} follow-up${followUps.length === 1 ? "" : "s"}`,
        brief: `Left undone: ${listed.join("; ")}${more ? `; and ${more} more` : ""}.`,
        source:
          sessions.size === 1
            ? only
              ? `session ${only.slice(0, 8)}`
              : "reported by an agent"
            : `${sessions.size} sessions`,
        since: followUps[0]!.createdAt,
        data: {
          projectId,
          followUps: followUps.map(({ id, text, agentSessionId }) => ({
            id,
            text,
            agentSessionId,
          })),
        },
      };
    });
  };

  const projectStats = (): Record<string, ProjectStats> => {
    const stats: Record<string, ProjectStats> = {};
    for (const row of sql.all("SELECT id, key, name FROM projects")) {
      const milestone = currentMilestone(mapProject(row));
      stats[String(row.id)] = {
        milestone: milestone
          ? {
              name: milestone.name,
              due: milestone.due,
              done: milestone.done,
              total: milestone.total,
            }
          : null,
      };
    }
    return stats;
  };

  /** Syncs the GitHub project that has waited longest, one per tick. */
  const tick = async (time: number) => {
    if (!ctx.env.githubToken) return;
    const due = first(
      sql,
      `SELECT p.id, p.key, p.name FROM projects p
         LEFT JOIN backlog_settings s ON s.project_id = p.id
       WHERE p.key LIKE 'github.com/%' AND (s.source IS NULL OR s.source = 'github')
         AND (s.attempted_at IS NULL OR s.attempted_at < ?)
       ORDER BY s.attempted_at IS NOT NULL, s.attempted_at LIMIT 1`,
      new Date(time - SYNC_INTERVAL_MS).toISOString(),
    );
    // A failure is recorded on the project and retried after the interval.
    if (due) await syncGithub(mapProject(due)).catch(() => undefined);
  };

  /** The milestone, what's in flight and next, and open follow-ups. */
  const projectContext = (project: ProjectRow) => {
    const settings = settingsFor(project);
    const open = items(project.id, true).map((item) => ({
      sourceId: item.sourceId,
      title: item.title,
      url: item.url,
      milestone: item.milestone,
      assignee: item.assignee,
      status: item.status,
    }));
    return {
      milestone: currentMilestone(project, settings),
      backlog: {
        source: settings.source,
        syncedAt: settings.syncedAt,
        syncError: settings.syncError,
        counts: counts(project.id),
      },
      inProgress: open.filter((item) => item.status === "in_progress"),
      upNext: open
        .filter((item) => item.status === "todo")
        .slice(0, CONTEXT_UP_NEXT),
      followUps: sql
        .all(
          "SELECT * FROM follow_ups WHERE project_id = ? AND state = 'open' ORDER BY created_at, rowid",
          project.id,
        )
        .map(mapFollowUp)
        .map(({ id, text, agentSessionId, createdAt }) => ({
          id,
          text,
          agentSessionId,
          createdAt,
        })),
    };
  };

  return {
    name: "backlog",
    agentRoutes,
    browserRoutes,
    inbox,
    projectStats,
    projectContext,
    tick,
  };
}

const SettingsInputSchema = z.object({
  project: z.string().trim().min(1).max(300),
  source: z.enum(backlogSources).optional(),
  script: z.string().max(SCRIPT_LIMIT).nullable().optional(),
  autoWrite: z.boolean().optional(),
  /** A milestone sourceId or name; null or "" goes back to the automatic choice. */
  milestone: z.string().max(200).nullable().optional(),
});

function count(view: MilestoneView, status: BacklogStatus) {
  if (status === "cancelled") return;
  view.total++;
  if (status === "done") view.done++;
  if (status === "in_progress") view.inProgress++;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function mapProject(row: Row): ProjectRow {
  return { id: String(row.id), key: String(row.key), name: String(row.name) };
}

function mapItem(row: Row): BacklogItemView {
  return {
    sourceId: String(row.source_id),
    title: String(row.title),
    status: row.status as BacklogStatus,
    url: optional(row.url),
    milestone: optional(row.milestone),
    priority: row.priority === null ? null : Number(row.priority),
    order: row.ord === null ? null : Number(row.ord),
    assignee: optional(row.assignee),
    labels: JSON.parse(String(row.labels)) as string[],
    body: optional(row.body),
    origin: row.origin === "local" ? "local" : "source",
    updatedAt: String(row.updated_at),
  };
}

function mapFollowUp(row: Row): FollowUpView {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    agentSessionId: optional(row.agent_session_id),
    text: String(row.text),
    state: row.state as FollowUpState,
    backlogSourceId: optional(row.backlog_source_id),
    createdAt: String(row.created_at),
    decidedAt: optional(row.decided_at),
  };
}
