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
  startedAt: string;
  updatedAt: string;
  /** When the status last changed. */
  statusSince: string;
  requests: LinkedRequest[];
}

/**
 * What `report` and the hooks send to POST /api/sessions/kim/report. Every
 * field but the id is optional; omitted fields keep their stored value.
 */
export interface ReportInput {
  id: string;
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
