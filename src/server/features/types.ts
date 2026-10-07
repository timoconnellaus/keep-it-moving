import type { Hono } from "hono";
import type { InboxItem, ProjectStats } from "../../shared/inbox.js";
import type { Sql } from "../sql.js";
import type { InterviewStore } from "../store.js";

export interface FeatureContext {
  sql: Sql;
  store: InterviewStore;
  /** Worker secrets and settings; absent in tests unless given. */
  env: { githubToken?: string | undefined };
  /** Web Push to Tim's devices: something new needs him. */
  notify: () => void;
  /** Tell open pages that project or inbox data changed, so they refetch. */
  changed: () => void;
}

/**
 * A slice of Keep it moving: its own tables, routes, inbox items and timer
 * work. Agent routes mount under /api/sessions/kim (the CLI's OAuth
 * resource), browser routes under /api/browser/kim (behind Access).
 */
export interface Feature {
  name: string;
  /** Agent (CLI) routes; paths are relative to /api/sessions/kim. */
  agentRoutes?: (app: Hono) => void;
  /** Browser routes; paths are relative to /api/browser/kim. */
  browserRoutes?: (app: Hono) => void;
  /** Everything this feature says needs Tim right now. */
  inbox?: () => InboxItem[];
  /** This feature's numbers for the project rail, keyed by project id. */
  projectStats?: () => Record<string, ProjectStats>;
  /** Runs about once a minute from the Durable Object alarm. */
  tick?: (now: number) => Promise<void> | void;
}
