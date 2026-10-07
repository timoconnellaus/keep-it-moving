/**
 * What an agent session is doing. `idle` means it finished its turn and is
 * waiting for Tim; `needs_you` means it asked for something (a permission,
 * an answer).
 */
export const agentSessionStatuses = [
  "running",
  "needs_you",
  "idle",
  "done",
] as const;
export type AgentSessionStatus = (typeof agentSessionStatuses)[number];

/** A request (interview) an agent session raised, as its session shows it. */
export interface LinkedRequest {
  id: string;
  token: string;
  title: string;
  status: "active" | "stopped";
  /** Unanswered questions; 0 once the interview is stopped. */
  open: number;
}

/** One Claude Code (later Codex or Pi) session, as it last reported. */
export interface AgentSessionView {
  /** The agent's own session id. */
  id: string;
  projectId: string | null;
  title: string | null;
  status: AgentSessionStatus;
  agent: string | null;
  location: "local" | "cloud" | null;
  machine: string | null;
  branch: string | null;
  worktree: string | null;
  cwd: string | null;
  prUrl: string | null;
  /** The latest summary of where it's up to. */
  brief: string | null;
  /** The latest notification, e.g. "Claude needs your permission to use Bash". */
  message: string | null;
  /** A cloud session's id on claude.ai (CLAUDE_CODE_REMOTE_SESSION_ID, cse_…). */
  remoteId: string | null;
  /** A cloud session's page on claude.ai/code, from its remote id. */
  url: string | null;
  startedAt: string;
  updatedAt: string;
  /** When the status last changed. */
  statusSince: string;
  requests: LinkedRequest[];
}

/** What a cloud session's CLAUDE_CODE_REMOTE_SESSION_ID looks like. */
export const REMOTE_SESSION_ID = /^cse_[A-Za-z0-9_-]{1,200}$/;

/**
 * A cloud session's claude.ai page: cse_abc → https://claude.ai/code/session_abc.
 * Null for anything that isn't a remote session id, so no other value
 * becomes a link.
 */
export function cloudSessionUrl(
  remoteId: string | null | undefined,
): string | null {
  if (!remoteId || !REMOTE_SESSION_ID.test(remoteId)) return null;
  return `https://claude.ai/code/${remoteId.replace(/^cse_/, "session_")}`;
}

/**
 * What `report` and the hooks send to POST /api/sessions/kim/report. Every
 * field but the id is optional; omitted fields keep their stored value.
 */
export interface ReportInput {
  /**
   * The agent's session id. Without it, `remoteId` finds the session the
   * hooks reported with that remote id, or becomes the id itself.
   */
  id?: string;
  /** A cloud session's CLAUDE_CODE_REMOTE_SESSION_ID (cse_…). */
  remoteId?: string;
  /** Normalised git remote; finds or creates the project. */
  projectKey?: string;
  title?: string;
  /** A title used only while the session has none, e.g. its first prompt. */
  defaultTitle?: string;
  status?: AgentSessionStatus;
  agent?: string;
  location?: "local" | "cloud";
  machine?: string;
  branch?: string;
  worktree?: string;
  cwd?: string;
  prUrl?: string;
  brief?: string;
  message?: string;
}
