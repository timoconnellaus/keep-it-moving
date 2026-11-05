/**
 * What needs the user, from one `kim overview` to the next: the status bar
 * item, and which notifications to show. Pure, so it's easy to test.
 */
import type {
  OwnInterview,
  Overview,
  SentInterview,
  Workspace,
} from "./protocol";

/** An agent waiting this long on unanswered questions gets a nudge. */
export const WAITING_MS = 10 * 60_000;

export interface Seen {
  /** Interview id → when its agent's latest reply was seen. */
  replies: Record<string, string>;
  /** Tokens of interviews sent to the user, seen already. */
  sent: string[];
  /** Interview id → the activity a "waiting" nudge was for. */
  nudged: Record<string, string>;
}
export const NOTHING_SEEN: Seen = { replies: {}, sent: [], nudged: {} };

export type Needing =
  | { kind: "own"; interview: OwnInterview }
  | { kind: "sent"; interview: SentInterview };

/** What waits on the user, own interviews first, most recent first. */
export function needing(overview: Overview): Needing[] {
  return [
    ...overview.sessions
      .filter(
        (item) => item.status === "active" && item.open > 0 && !item.assignee,
      )
      .map((interview) => ({ kind: "own" as const, interview })),
    ...overview.inbox
      .filter((item) => item.status === "active" && item.openQuestions > 0)
      .map((interview) => ({ kind: "sent" as const, interview })),
  ];
}

export interface StatusItem {
  visible: boolean;
  text: string;
  tooltip: string;
}

/** Shown only when something needs the user. */
export function statusItem(overview: Overview): StatusItem {
  const waiting = needing(overview);
  if (!waiting.length) return { visible: false, text: "", tooltip: "" };
  const titles = waiting.map((item) => item.interview.title);
  return {
    visible: true,
    text:
      waiting.length === 1
        ? `${clip(titles[0]!, 32)} needs you`
        : `${waiting.length} interviews need you`,
    // Orca allows 256 characters.
    tooltip: clip(`Keep it moving: ${titles.join(" · ")}. Click to open.`, 250),
  };
}

export interface Note {
  title: string;
  body: string;
}

/**
 * Notifications for what changed since `seen`: an agent's chat reply, an
 * interview sent to the user, an agent waiting 10+ minutes. The first look
 * (`first`) only records what's there, so a restart doesn't replay it.
 */
export function notifications(
  overview: Overview,
  seen: Seen,
  now: number,
  first: boolean,
): { notes: Note[]; seen: Seen } {
  const notes: Note[] = [];
  const next: Seen = {
    replies: { ...seen.replies },
    sent: [...seen.sent],
    nudged: { ...seen.nudged },
  };
  for (const interview of overview.sessions) {
    const reply = interview.lastReply;
    if (reply && reply.at !== seen.replies[interview.id]) {
      next.replies[interview.id] = reply.at;
      if (
        !first &&
        (!seen.replies[interview.id] || reply.at > seen.replies[interview.id]!)
      )
        notes.push({
          title: `${interview.title} · reply`,
          body: clip(plain(reply.text), 180),
        });
    }
    const idle = now - Date.parse(interview.lastActivity);
    if (
      interview.status === "active" &&
      interview.agentWatching &&
      interview.open > 0 &&
      !interview.assignee &&
      idle >= WAITING_MS &&
      seen.nudged[interview.id] !== interview.lastActivity
    ) {
      next.nudged[interview.id] = interview.lastActivity;
      if (!first)
        notes.push({
          title: `${interview.title} is waiting on you`,
          body: `Its agent has been waiting ${Math.round(idle / 60_000)} minutes on ${interview.open} open question${interview.open === 1 ? "" : "s"}.`,
        });
    }
  }
  for (const interview of overview.inbox)
    if (!seen.sent.includes(interview.id)) {
      next.sent.push(interview.id);
      if (!first)
        notes.push({
          title: `Sent to you: ${interview.title}`,
          body: `${interview.from ?? "Someone"} sent you ${interview.openQuestions} question${interview.openQuestions === 1 ? "" : "s"}.`,
        });
    }
  return { notes, seen: next };
}

/**
 * The own interviews started in a workspace, most recent first: the same
 * worktree folder, and the same branch when both say.
 */
export function interviewsIn(
  overview: Overview,
  workspace: Workspace | null,
): OwnInterview[] {
  if (!workspace) return [];
  const folder = basename(workspace.path);
  return overview.sessions
    .filter(
      (item) =>
        item.origin.worktree === folder &&
        (!item.origin.branch ||
          !workspace.branch ||
          item.origin.branch === workspace.branch),
    )
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

/** The focused workspace in Orca's list, from what `workspace.readContext` says. */
export function focusedWorkspace(
  workspaces: Workspace[],
  context: { branch: string; displayName: string } | null,
): Workspace | null {
  if (!context) return null;
  return (
    workspaces.find(
      (item) =>
        item.name === context.displayName && item.branch === context.branch,
    ) ??
    workspaces.find((item) => item.name === context.displayName) ??
    workspaces.find((item) => basename(item.path) === context.displayName) ??
    null
  );
}

const basename = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? path;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
/** Markdown's marks off, for a notification's plain text. */
const plain = (text: string) =>
  text
    .replace(/\\n/g, " ")
    .replace(/[*_`~#>]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
