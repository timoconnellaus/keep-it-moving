import type {
  CiState,
  LogExcerpt,
  PrFile,
  PrReview,
} from "../../../shared/github.js";

/** fetch, or a stand-in for tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GhPull {
  number: number;
  title: string;
  url: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  draft: boolean;
  author: string;
  updatedAt: string;
  state: "open" | "closed";
  body: string | null;
  /** The list endpoint leaves these out; one PR's detail has them. */
  merged: boolean;
  additions: number | null;
  deletions: number | null;
  mergeable: boolean | null;
  mergeableState: string | null;
}

export interface GhCheck {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  /** GitHub Actions check runs share their id with the job. */
  jobId: number | null;
}

/** A failed GitHub call; rateLimited calls say when the limit resets. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly resetAt: number | null = null,
  ) {
    super(message);
  }
  get rateLimited(): boolean {
    return (
      this.status === 429 || (this.status === 403 && this.resetAt !== null)
    );
  }
}

const API = "https://api.github.com";
const FAILED = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

/**
 * GitHub's REST API over fetch alone, so it runs on Workers. It counts its
 * requests, so callers can stay under a Worker's subrequest limit.
 */
export class GitHubClient {
  /** Requests made so far. */
  requests = 0;
  /** The rate limit left after the last response, and when it resets (ms). */
  remaining: number | null = null;
  resetAt: number | null = null;
  private readonly fetch: FetchLike;

  constructor(
    private readonly token: string,
    fetchImpl?: FetchLike,
  ) {
    // Bound late: Workers refuse a fetch called off its global.
    this.fetch = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private async request(path: string, init: RequestInit = {}) {
    this.requests++;
    const response = await this.fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "keep-it-moving (interviewer)",
        "x-github-api-version": "2022-11-28",
      },
    });
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (remaining !== null) this.remaining = Number(remaining);
    if (reset !== null) this.resetAt = Number(reset) * 1000;
    if (response.ok || (response.status >= 300 && response.status < 400))
      return response;
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      /* not JSON */
    }
    const retryAfter = response.headers.get("retry-after");
    const limited =
      response.status === 429 || this.remaining === 0 || retryAfter !== null;
    throw new GitHubError(
      response.status,
      `GitHub ${response.status}: ${message || response.statusText}`,
      limited
        ? retryAfter
          ? Date.now() + Number(retryAfter) * 1000
          : (this.resetAt ?? Date.now() + 15 * 60_000)
        : null,
    );
  }

  private async json<T>(path: string): Promise<T> {
    return (await (await this.request(path)).json()) as T;
  }

  /** Open PRs, most recently updated first (up to 200). */
  async openPulls(repo: string): Promise<GhPull[]> {
    const pulls: GhPull[] = [];
    for (let page = 1; page <= 2; page++) {
      const batch = await this.json<RawPull[]>(
        `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`,
      );
      pulls.push(...batch.map(toPull));
      if (batch.length < 100) break;
    }
    return pulls;
  }

  /** One PR, with its diff stats and GitHub's mergeability verdict. */
  async pull(repo: string, number: number): Promise<GhPull> {
    return toPull(await this.json<RawPull>(`/repos/${repo}/pulls/${number}`));
  }

  /** The latest run of each check on a commit. */
  async checkRuns(repo: string, sha: string): Promise<GhCheck[]> {
    const result = await this.json<{ check_runs: RawCheck[] }>(
      `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    );
    return result.check_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? null,
      url: run.html_url ?? run.details_url ?? null,
      jobId: run.app?.slug === "github-actions" ? run.id : null,
    }));
  }

  /** Each reviewer's latest review that approved, asked for changes or was dismissed. */
  async reviews(repo: string, number: number): Promise<PrReview[]> {
    const reviews = await this.json<RawReview[]>(
      `/repos/${repo}/pulls/${number}/reviews?per_page=100`,
    );
    const latest = new Map<string, PrReview>();
    for (const review of reviews) {
      const author = review.user?.login ?? "ghost";
      if (review.state === "PENDING") continue;
      // A comment after an approval doesn't undo it.
      if (review.state === "COMMENTED" && latest.has(author)) continue;
      latest.set(author, {
        author,
        state: review.state,
        submittedAt: review.submitted_at ?? null,
        url: review.html_url ?? null,
      });
    }
    return [...latest.values()];
  }

  /** Changed files with their patches, 100 a page, up to `max`. */
  async files(repo: string, number: number, max = 300): Promise<PrFile[]> {
    const files: PrFile[] = [];
    for (let page = 1; files.length < max; page++) {
      const batch = await this.json<RawFile[]>(
        `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      files.push(
        ...batch.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          previousFilename: file.previous_filename ?? null,
          patch: file.patch ?? null,
        })),
      );
      if (batch.length < 100) break;
    }
    return files.slice(0, max);
  }

  /**
   * A finished Actions job's log, trimmed to what explains a failure. GitHub
   * redirects to a signed blob URL, fetched without our token.
   */
  async jobLog(repo: string, jobId: number): Promise<LogExcerpt> {
    let response = await this.request(
      `/repos/${repo}/actions/jobs/${jobId}/logs`,
      { redirect: "manual" },
    );
    const location = response.headers.get("location");
    if (response.status >= 300 && location) {
      this.requests++;
      response = await this.fetch(location);
      if (!response.ok)
        throw new GitHubError(
          response.status,
          `Log download ${response.status}`,
        );
    }
    return logExcerpt(await response.text());
  }
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const ERROR = /##\[error\]|\berror\b/i;
export const LOG_TAIL = 60;

/** The last lines of a log, plus the lines around its first error when they come earlier. */
export function logExcerpt(text: string): LogExcerpt {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(TIMESTAMP, "").replace(ANSI, ""));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const tailStart = Math.max(0, lines.length - LOG_TAIL);
  const first = lines.findIndex((line) => ERROR.test(line));
  const around =
    first >= 0 && first < tailStart
      ? lines.slice(Math.max(0, first - 5), Math.min(first + 15, tailStart))
      : null;
  return { around, tail: lines.slice(tailStart) };
}

/** Rolls checks up the way GitHub's status does: failing beats running beats passing. */
export function rollUp(
  checks: { status: string; conclusion: string | null }[],
): { ci: CiState; failingIndexes: number[] } {
  const failingIndexes = checks.flatMap((check, index) =>
    check.status === "completed" && FAILED.has(check.conclusion ?? "")
      ? [index]
      : [],
  );
  if (failingIndexes.length) return { ci: "red", failingIndexes };
  if (!checks.length) return { ci: "none", failingIndexes };
  if (checks.some((check) => check.status !== "completed"))
    return { ci: "pending", failingIndexes };
  return { ci: "green", failingIndexes };
}

interface RawPull {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  body?: string | null;
  updated_at: string;
  user?: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  merged?: boolean;
  merged_at?: string | null;
  additions?: number;
  deletions?: number;
  mergeable?: boolean | null;
  mergeable_state?: string;
}
interface RawCheck {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  app?: { slug?: string } | null;
}
interface RawReview {
  user?: { login: string } | null;
  state: string;
  submitted_at?: string;
  html_url?: string;
}
interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

function toPull(raw: RawPull): GhPull {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    headRef: raw.head.ref,
    headSha: raw.head.sha,
    baseRef: raw.base.ref,
    draft: Boolean(raw.draft),
    author: raw.user?.login ?? "ghost",
    updatedAt: raw.updated_at,
    state: raw.state,
    body: raw.body ?? null,
    merged: Boolean(raw.merged ?? raw.merged_at),
    additions: raw.additions ?? null,
    deletions: raw.deletions ?? null,
    mergeable: raw.mergeable ?? null,
    mergeableState: raw.mergeable_state ?? null,
  };
}
