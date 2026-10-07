/** What can need Tim, in the order the inbox explains them. */
export type InboxKind =
  | "request"
  | "needs_you"
  | "ci_failed"
  | "automation_down"
  | "follow_ups"
  | "prs_ready";

/**
 * One thing that needs Tim. Features derive these from their own tables;
 * the inbox shows them oldest first and pushes new ones to the phone.
 */
export interface InboxItem {
  /** Stable across refreshes, e.g. "ci_failed:github.com/o/r#14". */
  id: string;
  kind: InboxKind;
  projectId: string | null;
  title: string;
  /** What happened and what's needed, in a sentence or three. */
  brief: string;
  /** Where it came from, e.g. 'session "D1 migration" · desktop · tim-mbp'. */
  source: string;
  /** When it started needing Tim (ISO); the inbox sorts on it. */
  since: string;
  /**
   * Waiting on Tim but not blocked, such as an agent that finished its turn:
   * it sorts after everything else.
   */
  later?: boolean;
  /** Kind-specific detail for the item's renderer. */
  data?: Record<string, unknown>;
}

/** The rail's at-a-glance numbers for a project; each feature fills its own. */
export interface ProjectStats {
  /** Inbox items for this project. */
  needsYou?: number;
  /** Agent sessions running now. */
  running?: number;
  openPrs?: number;
  /** The worst CI state across open PRs; null when there are none. */
  ci?: "green" | "red" | "pending" | null;
  /** The project's automations: down if any missed check-ins; null if none. */
  heartbeat?: "alive" | "down" | null;
  milestone?: {
    name: string;
    due: string | null;
    done: number;
    total: number;
  } | null;
}
