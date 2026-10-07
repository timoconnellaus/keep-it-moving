import { useEffect, useState } from "react";
import type { MilestoneView } from "../../../shared/backlog.js";
import type { AgentSessionView } from "../../../shared/sessions.js";
import type { ProjectSummaryView } from "../../../shared/summaries.js";
import { safeHref } from "../../../shared/url.js";
import { useJson, useLive } from "../shell/live.js";
import { ago, shortDate, useProjectBacklog } from "./api.js";

/** The newest agent-session brief for a project: "where it's up to". */
export interface LatestBrief {
  text: string;
  /** What it's based on, e.g. 'session "Fix watcher lease"'. */
  basedOn: string;
  at: string;
}

/** The newest brief any of the project's agent sessions reported. */
export async function loadLatestBrief(
  projectId: string,
): Promise<LatestBrief | null> {
  const response = await fetch(
    `/api/browser/kim/projects/${encodeURIComponent(projectId)}/sessions`,
  ).catch(() => null);
  if (!response?.ok) return null;
  const { sessions } = (await response.json()) as {
    sessions?: AgentSessionView[];
  };
  const latest = (sessions ?? [])
    .filter((session) => session.brief)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return latest
    ? {
        text: latest.brief!,
        basedOn: `session "${latest.title ?? "Untitled"}"`,
        at: latest.updatedAt,
      }
    : null;
}

/** What "Where it's up to" shows: a summary, or a session brief instead. */
export interface UpTo extends LatestBrief {
  /** A session brief standing in until an agent writes a summary. */
  fallback: boolean;
  stale: boolean;
}

/**
 * The newest summary an agent wrote for the project, or failing that the
 * newest session brief. Both refetch on the overview ping.
 */
function useUpTo(projectId: string, given?: LatestBrief | null): UpTo | null {
  const live = useLive();
  const { data, error } = useJson<{ summary?: ProjectSummaryView | null }>(
    `/api/browser/kim/projects/${encodeURIComponent(projectId)}/summary`,
  );
  const summary = data?.summary?.text ? data.summary : null;
  // Wait for the summary before falling back, so the brief doesn't flash.
  const settled = data !== null || error !== "";
  const [brief, setBrief] = useState<LatestBrief | null>(given ?? null);
  useEffect(() => {
    if (given !== undefined) return setBrief(given);
    if (summary || !settled) return;
    let current = true;
    void loadLatestBrief(projectId).then((found) => current && setBrief(found));
    return () => {
      current = false;
    };
  }, [projectId, given, summary, settled, live]);
  if (summary)
    return {
      text: summary.text,
      basedOn: summary.writtenByTitle
        ? `by session "${summary.writtenByTitle}"`
        : summary.writtenBy
          ? `by session ${summary.writtenBy.slice(0, 8)}`
          : "by an agent",
      at: summary.createdAt,
      fallback: false,
      stale: summary.stale,
    };
  return brief
    ? {
        ...brief,
        basedOn: `latest session brief · ${brief.basedOn}`,
        fallback: true,
        stale: false,
      }
    : null;
}

export function FlagIcon() {
  return (
    <svg className="kim-backlog-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </svg>
  );
}

/** "GitHub milestone · due 24 Oct · 5 of 11 done · 3 in progress" */
export function milestoneSummary(milestone: MilestoneView, source: string) {
  return [
    milestone.manual
      ? "Milestone"
      : source === "github"
        ? "GitHub milestone"
        : "Milestone",
    milestone.due ? `due ${shortDate(milestone.due)}` : null,
    `${milestone.done} of ${milestone.total} done`,
    milestone.inProgress ? `${milestone.inProgress} in progress` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The project's current milestone, its progress, and where it's up to. */
export function MilestoneSection({
  projectId,
  brief: givenBrief,
}: {
  projectId: string;
  /** The fallback brief, when the page already has it; otherwise fetched. */
  brief?: LatestBrief | null;
}) {
  const { view, error } = useProjectBacklog(projectId);
  const brief = useUpTo(projectId, givenBrief);
  if (!view)
    return (
      <div className="kim-backlog-milestone">
        <p className="kim-backlog-muted">{error ?? "Loading the milestone…"}</p>
      </div>
    );
  const milestone = view.milestone;
  const percent =
    milestone && milestone.total
      ? Math.round((milestone.done / milestone.total) * 100)
      : 0;
  return (
    <div className="kim-backlog-milestone">
      <div className="kim-backlog-milestone-head">
        <FlagIcon />
        {milestone ? (
          <>
            {milestone.url ? (
              <a
                className="kim-backlog-milestone-name"
                href={safeHref(milestone.url)}
                target="_blank"
                rel="noreferrer"
              >
                {milestone.name}
              </a>
            ) : (
              <b className="kim-backlog-milestone-name">{milestone.name}</b>
            )}
            <span className="kim-backlog-muted">
              {milestoneSummary(milestone, view.settings.source)}
            </span>
          </>
        ) : (
          <>
            <b className="kim-backlog-milestone-name">No milestone</b>
            <span className="kim-backlog-muted">
              {view.counts?.total
                ? "Nothing in the backlog has a milestone yet"
                : "Set one with `kim backlog milestone add <name>`"}
            </span>
          </>
        )}
      </div>
      {milestone ? (
        <div
          className="kim-backlog-progress"
          role="progressbar"
          aria-label={`${milestone.name} progress`}
          aria-valuemin={0}
          aria-valuemax={milestone.total}
          aria-valuenow={milestone.done}
        >
          <div style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {brief ? (
        <div className="kim-backlog-upto">
          <b>Where it's up to.</b> {brief.text}
          <div className="kim-backlog-muted kim-backlog-small">
            {brief.basedOn} · {ago(brief.at)}
            {brief.stale ? " · sessions and PRs have moved since" : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
