import { z } from "zod";
import type { InboxItem, ProjectStats } from "../../shared/inbox.js";
import {
  agentSessionStatuses,
  type AgentSessionStatus,
  type AgentSessionView,
  type LinkedRequest,
} from "../../shared/sessions.js";
import { first, type Row } from "../sql.js";
import type { Feature, FeatureContext } from "./types.js";

const text = (max: number) => z.string().trim().min(1).max(max);

const ReportSchema = z.object({
  id: text(200),
  projectKey: text(300).optional(),
  title: text(200).optional(),
  defaultTitle: text(200).optional(),
  status: z.enum(agentSessionStatuses).optional(),
  agent: text(100).optional(),
  location: z.enum(["local", "cloud"]).optional(),
  machine: text(200).optional(),
  branch: text(300).optional(),
  worktree: text(300).optional(),
  cwd: text(1_000).optional(),
  prUrl: text(500).optional(),
  brief: text(4_000).optional(),
  message: text(2_000).optional(),
});

/** Columns a report can set directly, by the report field that sets them. */
const FIELDS = {
  agent: "agent",
  location: "location",
  machine: "machine",
  branch: "branch",
  worktree: "worktree",
  cwd: "cwd",
  prUrl: "pr_url",
  brief: "brief",
} as const;

const HOUR = 3_600_000;
/** A done session stays on its project page this long. */
const DONE_SHOWN_MS = 24 * HOUR;
/** A session that stopped reporting without a SessionEnd drops off after this. */
const STALE_MS = 7 * 24 * HOUR;

const waiting = (status: unknown) =>
  status === "needs_you" || status === "idle";
const optional = (value: unknown) =>
  value === null || value === undefined ? null : String(value);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/**
 * Agent sessions: what each Claude Code session is doing, reported by its
 * hooks and `interviewer report`, plus the requests (interviews) they raise.
 */
export function sessionsFeature(ctx: FeatureContext): Feature {
  const { sql } = ctx;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT,
      status TEXT NOT NULL DEFAULT 'running', agent TEXT, location TEXT, machine TEXT,
      branch TEXT, worktree TEXT, cwd TEXT, pr_url TEXT, brief TEXT, message TEXT,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, status_since TEXT NOT NULL,
      waiting_since TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_sessions_project ON agent_sessions(project_id, updated_at);
  `);

  /** Upserts a report; a status change restarts status_since. */
  const report = (input: unknown): AgentSessionView => {
    const parsed = ReportSchema.parse(input);
    const time = new Date().toISOString();
    const existing = first(
      sql,
      "SELECT * FROM agent_sessions WHERE id = ?",
      parsed.id,
    );
    const projectId = parsed.projectKey
      ? ctx.store.projectForKey(parsed.projectKey).id
      : optional(existing?.project_id);
    const status: AgentSessionStatus =
      parsed.status ?? (existing?.status as AgentSessionStatus) ?? "running";
    const changed = !existing || existing.status !== status;
    // One stretch of waiting (a Stop, then the idle Notification a minute
    // later) is one inbox item, so it keeps the time the wait began.
    const waitingSince = !waiting(status)
      ? null
      : existing && waiting(existing.status) && existing.waiting_since
        ? String(existing.waiting_since)
        : time;
    const keep = (field: keyof typeof FIELDS) =>
      parsed[field] ?? optional(existing?.[FIELDS[field]]);
    sql.all(
      `INSERT INTO agent_sessions (id, project_id, title, status, agent, location, machine, branch,
        worktree, cwd, pr_url, brief, message, started_at, updated_at, status_since, waiting_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title,
        status = excluded.status, agent = excluded.agent, location = excluded.location,
        machine = excluded.machine, branch = excluded.branch, worktree = excluded.worktree,
        cwd = excluded.cwd, pr_url = excluded.pr_url, brief = excluded.brief,
        message = excluded.message, updated_at = excluded.updated_at,
        status_since = excluded.status_since, waiting_since = excluded.waiting_since`,
      parsed.id,
      projectId,
      parsed.title ?? optional(existing?.title) ?? parsed.defaultTitle ?? null,
      status,
      keep("agent"),
      keep("location"),
      keep("machine"),
      keep("branch"),
      keep("worktree"),
      keep("cwd"),
      keep("prUrl"),
      keep("brief"),
      // A notification is stale once the status moves on.
      parsed.message ?? (changed ? null : optional(existing?.message)),
      existing ? String(existing.started_at) : time,
      time,
      changed ? time : String(existing!.status_since),
      waitingSince,
    );
    ctx.changed();
    return get(parsed.id);
  };

  const requestsFor = (agentSessionId: string): LinkedRequest[] =>
    sql
      .all(
        `SELECT s.id, s.token, s.title, s.status,
          (SELECT COUNT(*) FROM questions q LEFT JOIN answers a ON a.question_id = q.id
            WHERE q.session_id = s.id AND q.deleted = 0 AND a.question_id IS NULL) open
         FROM sessions s WHERE s.agent_session_id = ? ORDER BY s.created_at DESC`,
        agentSessionId,
      )
      .map((row) => ({
        id: String(row.id),
        token: String(row.token),
        title: String(row.title),
        status: row.status as LinkedRequest["status"],
        open: row.status === "active" ? Number(row.open) : 0,
      }));

  const view = (row: Row): AgentSessionView => ({
    id: String(row.id),
    projectId: optional(row.project_id),
    title: optional(row.title),
    status: row.status as AgentSessionStatus,
    agent: optional(row.agent),
    location: optional(row.location) as AgentSessionView["location"],
    machine: optional(row.machine),
    branch: optional(row.branch),
    worktree: optional(row.worktree),
    cwd: optional(row.cwd),
    prUrl: optional(row.pr_url),
    brief: optional(row.brief),
    message: optional(row.message),
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    statusSince: String(row.status_since),
    requests: requestsFor(String(row.id)),
  });

  const get = (id: string): AgentSessionView => {
    const row = first(sql, "SELECT * FROM agent_sessions WHERE id = ?", id);
    if (!row) throw new Error("Agent session not found");
    return view(row);
  };

  /** Active sessions, plus those done in the last day, most recent first. */
  const forProject = (projectId: string): AgentSessionView[] =>
    sql
      .all(
        `SELECT * FROM agent_sessions WHERE project_id = ?
          AND ((status != 'done' AND updated_at > ?) OR (status = 'done' AND updated_at > ?))
         ORDER BY updated_at DESC`,
        projectId,
        ago(STALE_MS),
        ago(DONE_SHOWN_MS),
      )
      .map(view);

  /** Where a session runs, as one line: 'session "Title" · cloud · tim-mbp'. */
  const sourceOf = (row: Row | undefined, fallback: Array<unknown>) =>
    (row
      ? [
          `session "${optional(row.title) ?? "Untitled"}"`,
          row.location,
          row.machine,
        ]
      : fallback
    )
      .filter(Boolean)
      .join(" · ");

  const inbox = (): InboxItem[] => {
    // Interviews waiting on answers. Agents raise these with `ask`.
    const requests = sql.all(
      `SELECT s.*, COUNT(q.id) open_count, MIN(q.created_at) since,
        (SELECT q2.prompt FROM questions q2 LEFT JOIN answers a2 ON a2.question_id = q2.id
          WHERE q2.session_id = s.id AND q2.deleted = 0 AND a2.question_id IS NULL
          ORDER BY q2.position, q2.created_at LIMIT 1) first_prompt
       FROM sessions s
       JOIN questions q ON q.session_id = s.id AND q.deleted = 0
       LEFT JOIN answers a ON a.question_id = q.id
       WHERE s.status = 'active' AND a.question_id IS NULL
       GROUP BY s.id`,
    );
    const linked = new Set<string>();
    const items: InboxItem[] = requests.map((row) => {
      const agentSessionId = optional(row.agent_session_id);
      if (agentSessionId) linked.add(agentSessionId);
      const agentSession = agentSessionId
        ? first(
            sql,
            "SELECT * FROM agent_sessions WHERE id = ?",
            agentSessionId,
          )
        : undefined;
      const open = Number(row.open_count);
      return {
        id: `request:${String(row.id)}@${String(row.since)}`,
        kind: "request",
        projectId:
          optional(row.project_id) ?? optional(agentSession?.project_id),
        title: String(row.title),
        brief: optional(agentSession?.brief) ?? String(row.first_prompt),
        source: sourceOf(agentSession, [
          row.agent_session && `session "${String(row.agent_session)}"`,
          row.agent,
          row.location,
          row.branch,
        ]),
        since: String(row.since),
        data: {
          token: String(row.token),
          openQuestions: open,
          interviewId: String(row.id),
          agentSessionId,
        },
      };
    });
    // Sessions waiting on Tim that haven't raised a request.
    const sessions = sql.all(
      `SELECT * FROM agent_sessions WHERE status IN ('needs_you', 'idle') AND updated_at > ?`,
      ago(STALE_MS),
    );
    for (const row of sessions) {
      if (linked.has(String(row.id))) continue;
      const since = String(row.waiting_since ?? row.status_since);
      const idle = row.status === "idle";
      items.push({
        id: `needs_you:${String(row.id)}@${since}`,
        kind: "needs_you",
        projectId: optional(row.project_id),
        title: optional(row.title) ?? "Untitled session",
        brief:
          optional(row.brief) ??
          optional(row.message) ??
          (idle ? "Finished its turn." : "Waiting for you."),
        source: sourceOf(row, []),
        since,
        ...(idle ? { later: true } : {}),
        data: {
          agentSessionId: String(row.id),
          status: String(row.status),
          message: optional(row.message),
          location: optional(row.location),
          machine: optional(row.machine),
          branch: optional(row.branch),
          worktree: optional(row.worktree),
          agent: optional(row.agent),
          prUrl: optional(row.pr_url),
        },
      });
    }
    return items;
  };

  const projectStats = (): Record<string, ProjectStats> =>
    Object.fromEntries(
      sql
        .all(
          `SELECT project_id, SUM(status = 'running' AND updated_at > ?) running
           FROM agent_sessions WHERE project_id IS NOT NULL GROUP BY project_id`,
          ago(STALE_MS),
        )
        .map((row) => [
          String(row.project_id),
          { running: Number(row.running ?? 0) },
        ]),
    );

  return {
    name: "sessions",
    agentRoutes(app) {
      app.post("/report", async (c) =>
        c.json(report(await c.req.json().catch(() => ({})))),
      );
    },
    browserRoutes(app) {
      app.get("/projects/:id/sessions", (c) =>
        c.json({ sessions: forProject(c.req.param("id")) }),
      );
      app.get("/sessions/:id", (c) => c.json(get(c.req.param("id"))));
    },
    inbox,
    projectStats,
  };
}
