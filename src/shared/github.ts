/** A PR's checks rolled up: any failing is red, then any running is pending. */
export type CiState = "green" | "red" | "pending" | "none";

export interface PrCheck {
  name: string;
  /** queued, in_progress or completed. */
  status: string;
  /** success, failure, neutral, cancelled, skipped, timed_out… once completed. */
  conclusion: string | null;
  url: string | null;
}

/** An open (or recently closed) PR as the server last synced it. */
export interface PrSummary {
  projectId: string;
  number: number;
  title: string;
  url: string;
  headRef: string;
  headSha: string;
  draft: boolean;
  author: string;
  additions: number;
  deletions: number;
  state: "open" | "closed" | "merged";
  ci: CiState;
  checks: PrCheck[];
  mergeableState: string | null;
  ready: boolean;
  /** Names of the failing checks. */
  failing: string[];
  updatedAt: string;
  syncedAt: string;
  ciFailedSince: string | null;
  readySince: string | null;
}

export interface PrListResponse {
  /** owner/repo, or null when the project isn't on GitHub. */
  repo: string | null;
  prs: PrSummary[];
  /** When the project last synced, and what went wrong if it failed. */
  syncedAt: string | null;
  error: string | null;
}

/** A failing Actions job's log: the lines around the first error and the tail. */
export interface LogExcerpt {
  around: string[] | null;
  tail: string[];
}

export interface PrCheckDetail extends PrCheck {
  /** The Actions job id, when GitHub Actions ran the check. */
  jobId: number | null;
  log: LogExcerpt | null;
}

export interface PrReview {
  author: string;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED or DISMISSED: each reviewer's latest. */
  state: string;
  submittedAt: string | null;
  url: string | null;
}

export interface PrFile {
  filename: string;
  /** added, removed, modified, renamed, copied, changed or unchanged. */
  status: string;
  additions: number;
  deletions: number;
  previousFilename: string | null;
  /** Unified diff hunks; GitHub omits them for binary and very large files. */
  patch: string | null;
}

/** GET /api/browser/kim/projects/:id/prs/:number: live from GitHub. */
export interface PrDetailResponse {
  repo: string;
  pr: PrSummary & { body: string | null; baseRef: string; merged: boolean };
  checks: PrCheckDetail[];
  reviews: PrReview[];
  files: PrFile[];
  /** GitHub lists at most 3000 files; we fetch up to about 300. */
  filesTruncated: boolean;
  fetchedAt: string;
}

/** The state a PR row shows, in the order the labels take precedence. */
export function prLabel(
  pr: Pick<PrSummary, "state" | "draft" | "ready" | "ci">,
): "Merged" | "Closed" | "Draft" | "CI failed" | "Ready" | "Pending" | "Open" {
  if (pr.state === "merged") return "Merged";
  if (pr.state === "closed") return "Closed";
  if (pr.draft) return "Draft";
  if (pr.ci === "red") return "CI failed";
  if (pr.ready) return "Ready";
  if (pr.ci === "pending") return "Pending";
  return "Open";
}

export interface DiffLine {
  /** note is git's "\ No newline at end of file". */
  kind: "add" | "del" | "ctx" | "note";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  /** The function or section name git prints after the second @@. */
  section: string;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Parses a unified diff patch, as GitHub returns per file, into numbered lines. */
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const header = line.match(HUNK);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      hunk = {
        header: line,
        oldStart: oldNo,
        newStart: newNo,
        section: header[5] ?? "",
        lines: [],
      };
      hunks.push(hunk);
      continue;
    }
    // Anything before the first hunk (a diff --git preamble) isn't shown.
    if (!hunk) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === "+")
      hunk.lines.push({ kind: "add", text, oldNo: null, newNo: newNo++ });
    else if (mark === "-")
      hunk.lines.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
    else if (mark === "\\")
      hunk.lines.push({ kind: "note", text: line, oldNo: null, newNo: null });
    else
      hunk.lines.push({
        kind: "ctx",
        text: mark === " " ? text : line,
        oldNo: oldNo++,
        newNo: newNo++,
      });
  }
  return hunks;
}

/** Files grouped by directory for the diff's file tree, directories sorted. */
export function groupByDirectory<T extends { filename: string }>(
  files: T[],
): { dir: string; files: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const slash = file.filename.lastIndexOf("/");
    const dir = slash < 0 ? "" : file.filename.slice(0, slash);
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, list]) => ({
      dir,
      files: list.sort((a, b) => a.filename.localeCompare(b.filename)),
    }));
}
