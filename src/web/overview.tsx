import { useCallback, useEffect, useState } from "react";
import type { ProjectView, SessionSummary } from "../shared/schema.js";

/** Every interview, refetched whenever `version` changes (the server pings on changes). */
export function useOverview(version: number): SessionSummary[] | null {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/browser/overview").catch(() => null);
    if (!response?.ok) return;
    setSessions(
      ((await response.json()) as { sessions: SessionSummary[] }).sessions,
    );
  }, []);
  useEffect(() => {
    void load();
  }, [load, version]);
  return sessions;
}

export interface ProjectGroup {
  project: ProjectView | null;
  sessions: SessionSummary[];
}

const rank = (session: SessionSummary) =>
  session.status === "stopped" ? 2 : session.open > 0 ? 0 : 1;

/**
 * Interviews grouped by project. Projects are ordered by their latest
 * activity; within one, interviews waiting on the user come first, then
 * fully answered ones, then finished ones, each most recent first.
 */
export function groupByProject(sessions: SessionSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    const key = session.project?.id ?? "";
    const group = groups.get(key) ?? { project: session.project, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  const latest = (group: ProjectGroup) =>
    Math.max(...group.sessions.map((item) => Date.parse(item.lastActivity)));
  for (const group of groups.values())
    group.sessions.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Date.parse(b.lastActivity) - Date.parse(a.lastActivity),
    );
  return [...groups.values()].sort((a, b) =>
    !a.project ? 1 : !b.project ? -1 : latest(b) - latest(a),
  );
}

export function sessionState(session: SessionSummary) {
  if (session.status === "stopped")
    return { label: "Finished", className: "state-done" };
  if (session.open > 0) return { label: "Needs you", className: "state-you" };
  return { label: "All answered", className: "state-agent" };
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 172_800) return "yesterday";
  return `${Math.floor(seconds / 86_400)} days ago`;
}

export function ProjectChip({
  project,
  size = 22,
}: {
  project: ProjectView | null;
  size?: number;
}) {
  return (
    <span
      className="project-chip"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        background: project?.color ?? "#8a948e",
      }}
    >
      {project?.name.trim()[0]?.toUpperCase() ?? "·"}
    </span>
  );
}

/** Branch, agent session and last activity, as one quiet line. */
export function OriginLine({ session }: { session: SessionSummary }) {
  const { branch, agent, agentSession, location } = session.origin;
  return (
    <span className="origin-line">
      {branch && (
        <span className="origin-branch">
          <BranchIcon />
          <span>{branch}</span>
        </span>
      )}
      {(agent || agentSession) && (
        <span className="origin-agent">
          {location === "cloud" ? <CloudIcon /> : <LaptopIcon />}
          {[agent, agentSession && `“${agentSession}”`]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
      <span className="origin-time">{relativeTime(session.lastActivity)}</span>
    </span>
  );
}

const icon = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
function BranchIcon() {
  return (
    <svg {...icon}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7v10M18 10c0 4-6 3-11 7" />
    </svg>
  );
}
function LaptopIcon() {
  return (
    <svg {...icon}>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2 19h20" />
    </svg>
  );
}
function CloudIcon() {
  return (
    <svg {...icon}>
      <path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9.5 4.25 4.25 0 0 0 7 18z" />
    </svg>
  );
}

export function Progress({
  answered,
  total,
}: {
  answered: number;
  total: number;
}) {
  return (
    <span
      className="mini-progress"
      aria-label={`${answered} of ${total} answered`}
    >
      <span className="progress-count">
        {answered}/{total}
      </span>
      <span className="progress-bar" aria-hidden="true">
        <span style={{ width: `${total ? (answered / total) * 100 : 0}%` }} />
      </span>
    </span>
  );
}
