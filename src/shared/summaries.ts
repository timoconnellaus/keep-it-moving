/** A summary is a few sentences; this leaves room without inviting an essay. */
export const SUMMARY_MAX = 2_000;

/**
 * "Where it's up to": a few sentences an agent wrote about a project
 * against its milestone, with who wrote it and when.
 */
export interface ProjectSummaryView {
  text: string;
  /** The agent session that wrote it, when the CLI knew it. */
  writtenBy: string | null;
  writtenByTitle: string | null;
  createdAt: string;
  /**
   * Older than a day, with sessions or PRs moving since: worth asking an
   * agent for a fresh one.
   */
  stale: boolean;
}
