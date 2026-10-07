import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  SUMMARY_MAX,
  type ProjectSummaryView,
} from "../../shared/summaries.js";
import { first, type Row } from "../sql.js";
import type { Feature, FeatureContext, ProjectRef } from "./types.js";

const HOUR = 3_600_000;
/** A summary this old, with activity since, is stale. */
const STALE_AFTER_MS = 24 * HOUR;

const SummaryInputSchema = z.object({
  project: z.string().trim().min(1).max(300),
  text: z.string().trim().min(1).max(SUMMARY_MAX),
  /** CLAUDE_CODE_SESSION_ID, or a cloud session's remote id. */
  agentSessionId: z.string().trim().min(1).max(200).optional(),
  remoteId: z.string().trim().min(1).max(200).optional(),
});

const optional = (value: unknown) =>
  value === null || value === undefined ? null : String(value);

/**
 * Project summaries: "where it's up to", written by agents. The server
 * calls no model. An agent (Claude already) reads `kim project context`,
 * writes a few sentences, and saves them with `kim project summary`; the
 * project page shows the newest. Every summary is kept.
 */
export function summariesFeature(
  ctx: FeatureContext,
  /** Every feature, so the context can gather each one's part. */
  features: () => Feature[],
): Feature {
  const { sql, store } = ctx;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS project_summaries (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL,
      written_by TEXT, written_by_title TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_summaries_project ON project_summaries(project_id, created_at);
  `);

  /** A project by id, key or name. */
  const findProject = (ref: string): ProjectRef | null => {
    const row = first(
      sql,
      "SELECT id, key, name FROM projects WHERE id = ? OR key = ? OR lower(name) = lower(?)",
      ref,
      ref,
      ref,
    );
    return row ? mapProject(row) : null;
  };
  const requireProject = (ref: unknown): ProjectRef => {
    if (typeof ref !== "string" || !ref.trim())
      throw new Error("project is required (its key, e.g. github.com/o/r)");
    const project = findProject(ref.trim());
    if (!project) throw new Error("Project not found");
    return project;
  };

  /** The newest time a session or PR in the project moved, or null. */
  const lastActivity = (projectId: string): string | null => {
    const times: string[] = [];
    for (const query of [
      "SELECT MAX(updated_at) at FROM agent_sessions WHERE project_id = ?",
      "SELECT MAX(updated_at) at FROM prs WHERE project_id = ?",
    ])
      try {
        const at = optional(first(sql, query, projectId)?.at);
        if (at) times.push(at);
      } catch {
        /* that feature isn't here */
      }
    return times.sort().pop() ?? null;
  };

  const view = (row: Row, now = Date.now()): ProjectSummaryView => {
    const createdAt = String(row.created_at);
    const activity = lastActivity(String(row.project_id));
    return {
      text: String(row.text),
      writtenBy: optional(row.written_by),
      writtenByTitle: optional(row.written_by_title),
      createdAt,
      stale:
        now - Date.parse(createdAt) > STALE_AFTER_MS &&
        activity !== null &&
        Date.parse(activity) > Date.parse(createdAt),
    };
  };

  const latest = (projectId: string): ProjectSummaryView | null => {
    const row = first(
      sql,
      "SELECT * FROM project_summaries WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      projectId,
    );
    return row ? view(row) : null;
  };

  /**
   * The agent session that wrote a summary: by its id, or a cloud session's
   * remote id. Unknown ids are kept as given, without a title.
   */
  const writer = (id: string | undefined, remoteId: string | undefined) => {
    const wanted = id ?? remoteId;
    if (!wanted) return { id: null, title: null };
    let row: Row | undefined;
    try {
      row =
        first(
          sql,
          "SELECT id, title FROM agent_sessions WHERE id = ?",
          wanted,
        ) ??
        first(
          sql,
          "SELECT id, title FROM agent_sessions WHERE remote_id = ? ORDER BY updated_at DESC LIMIT 1",
          remoteId ?? wanted,
        );
    } catch {
      /* no sessions feature */
    }
    return {
      id: row ? String(row.id) : wanted,
      title: optional(row?.title),
    };
  };

  const save = (input: unknown) => {
    const parsed = SummaryInputSchema.parse(input);
    const found = findProject(parsed.project);
    // A repo's key names its project even before anything else reported.
    const project =
      found ??
      (parsed.project.includes("/")
        ? store.projectForKey(parsed.project)
        : requireProject(parsed.project));
    const by = writer(parsed.agentSessionId, parsed.remoteId);
    const id = crypto.randomUUID();
    sql.all(
      `INSERT INTO project_summaries (id, project_id, text, written_by, written_by_title, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      project.id,
      parsed.text,
      by.id,
      by.title,
      new Date().toISOString(),
    );
    ctx.changed();
    return {
      project: { id: project.id, key: project.key, name: project.name },
      summary: latest(project.id),
    };
  };

  /**
   * Everything an agent needs to write the summary, in one object: each
   * feature adds its part; a feature that fails or isn't here leaves its
   * defaults.
   */
  const context = (project: ProjectRef) => {
    const parts: Record<string, unknown> = {
      project,
      generatedAt: new Date().toISOString(),
      milestone: null,
      inProgress: [],
      upNext: [],
      followUps: [],
      sessions: [],
      prs: [],
      automations: [],
    };
    for (const feature of features())
      try {
        Object.assign(parts, feature.projectContext?.(project));
      } catch (error) {
        console.error(`context ${feature.name}`, error);
      }
    return { ...parts, previousSummary: latest(project.id) };
  };

  const body = async (c: Context): Promise<Record<string, unknown>> =>
    ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  return {
    name: "summaries",
    agentRoutes(app: Hono) {
      app.get("/projects/context", (c) =>
        c.json(context(requireProject(c.req.query("project")))),
      );
      app.post("/projects/summary", async (c) => c.json(save(await body(c))));
    },
    browserRoutes(app: Hono) {
      app.get("/projects/:id/summary", (c) => {
        const project = findProject(c.req.param("id"));
        if (!project) return c.json({ error: "Project not found" }, 404);
        return c.json({ summary: latest(project.id) });
      });
    },
  };
}

function mapProject(row: Row): ProjectRef {
  return { id: String(row.id), key: String(row.key), name: String(row.name) };
}
