import {
  BODY_LIMIT,
  type BacklogItemInput,
  type BacklogMilestoneInput,
  type BacklogSyncOutput,
} from "../../shared/backlog.js";

/** Closed issues this recent still count toward their milestone's progress. */
const CLOSED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** 500 issues of each kind is plenty for a personal backlog. */
const MAX_PAGES = 5;

export type Fetch = typeof fetch;

/** A minimal GitHub REST client for issues and milestones. */
export function githubClient(token: string, fetcher: Fetch = fetch) {
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetcher(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "keep-it-moving",
        "x-github-api-version": "2022-11-28",
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `GitHub ${response.status}: ${detail.message ?? response.statusText}`,
      );
    }
    return response.json() as Promise<unknown>;
  };
  const pages = async <T>(path: string): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = (await request(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      )) as T[];
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  };
  return { request, pages };
}

export type GithubClient = ReturnType<typeof githubClient>;

/** "github.com/owner/repo" → "owner/repo"; null for other hosts. */
export function githubRepo(key: string): string | null {
  const match = key.match(/^github\.com\/([^/]+\/[^/]+)$/);
  return match ? match[1]! : null;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason?: string | null;
  html_url: string;
  body?: string | null;
  closed_at?: string | null;
  assignee?: { login: string } | null;
  assignees?: { login: string }[] | null;
  labels?: (string | { name?: string | null })[];
  milestone?: { number: number; title: string } | null;
  pull_request?: unknown;
}

export interface GithubMilestone {
  number: number;
  title: string;
  due_on?: string | null;
  html_url: string;
}

/** Open issues, issues closed in the last 14 days, and open milestones. */
export async function fetchGithubBacklog(
  client: GithubClient,
  repo: string,
  now = Date.now(),
): Promise<BacklogSyncOutput> {
  const since = new Date(now - CLOSED_WINDOW_MS).toISOString();
  const [open, closed, milestones] = await Promise.all([
    client.pages<GithubIssue>(`/repos/${repo}/issues?state=open`),
    // `since` filters on the update time; closed_at narrows it below.
    client.pages<GithubIssue>(
      `/repos/${repo}/issues?state=closed&since=${encodeURIComponent(since)}`,
    ),
    client.pages<GithubMilestone>(`/repos/${repo}/milestones?state=open`),
  ]);
  const recent = closed.filter(
    (issue) => issue.closed_at && issue.closed_at >= since,
  );
  return mapGithubBacklog([...open, ...recent], milestones);
}

/** GitHub's issues and milestones as normalised backlog items, in backlog order. */
export function mapGithubBacklog(
  issues: GithubIssue[],
  milestones: GithubMilestone[],
): BacklogSyncOutput {
  const mappedMilestones: BacklogMilestoneInput[] = milestones.map(
    (milestone) => ({
      sourceId: String(milestone.number),
      name: milestone.title,
      due: milestone.due_on ? milestone.due_on.slice(0, 10) : undefined,
      url: milestone.html_url,
    }),
  );
  const due = new Map(
    mappedMilestones.map((milestone) => [milestone.sourceId, milestone.due]),
  );
  const seen = new Set<number>();
  const items = issues
    .filter((issue) => !issue.pull_request)
    .filter((issue) => !seen.has(issue.number) && seen.add(issue.number))
    .map((issue) => mapIssue(issue))
    .sort((a, b) =>
      compareOrder(
        [
          due.get(a.milestone ?? ""),
          a.priority,
          Number(a.sourceId) || undefined,
        ],
        [
          due.get(b.milestone ?? ""),
          b.priority,
          Number(b.sourceId) || undefined,
        ],
      ),
    )
    .map((item, index) => ({ ...item, order: index }));
  return { items, milestones: mappedMilestones };
}

function mapIssue(issue: GithubIssue): BacklogItemInput {
  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .filter(Boolean);
  const assignee = issue.assignee?.login ?? issue.assignees?.[0]?.login;
  const inProgress = labels.some((label) => IN_PROGRESS.test(label));
  return {
    sourceId: String(issue.number),
    title: issue.title,
    status:
      issue.state === "closed"
        ? issue.state_reason === "not_planned"
          ? "cancelled"
          : "done"
        : assignee || inProgress
          ? "in_progress"
          : "todo",
    url: issue.html_url,
    milestone: issue.milestone ? String(issue.milestone.number) : undefined,
    priority: labelPriority(labels),
    order: undefined,
    assignee,
    labels,
    body: issue.body ? issue.body.slice(0, BODY_LIMIT) : undefined,
  };
}

const IN_PROGRESS = /^(status:\s*)?in[\s_-]?progress$/i;

const NAMED_PRIORITIES: Record<string, number> = {
  critical: 0,
  urgent: 0,
  high: 1,
  medium: 2,
  normal: 2,
  low: 3,
};

/** P0, P1, "priority: high", "priority/p2": the most urgent label wins. */
export function labelPriority(labels: string[]): number | undefined {
  let best: number | undefined;
  for (const label of labels) {
    const value = label.trim().toLowerCase();
    const numbered = value.match(/^(?:priority[\s:/-]*)?p([0-9])$/);
    const named = value.match(/^priority[\s:/-]+([a-z]+)$/);
    const priority = numbered
      ? Number(numbered[1])
      : named
        ? NAMED_PRIORITIES[named[1]!]
        : undefined;
    if (priority !== undefined && (best === undefined || priority < best))
      best = priority;
  }
  return best;
}

/** Compares sort keys in turn; a missing key sorts after any present one. */
export function compareOrder(
  a: (string | number | undefined)[],
  b: (string | number | undefined)[],
): number {
  for (let index = 0; index < a.length; index++) {
    const left = a[index];
    const right = b[index];
    if (left === right) continue;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** Opens an issue for an accepted follow-up; the first line is its title. */
export async function createGithubIssue(
  client: GithubClient,
  repo: string,
  text: string,
  agentSessionId: string | null,
): Promise<{ number: number; html_url: string; title: string }> {
  const [first = text, ...rest] = text.split("\n");
  const title = first.length > 250 ? `${first.slice(0, 249)}…` : first;
  const body = [
    first.length > 250 ? text : rest.join("\n").trim(),
    `Follow-up${agentSessionId ? ` from agent session ${agentSessionId}` : ""}, accepted in Keep it moving.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return (await client.request(`/repos/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body }),
  })) as { number: number; html_url: string; title: string };
}
