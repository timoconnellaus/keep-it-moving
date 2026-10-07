import type {
  AgentSessionStatus,
  AgentSessionView,
} from "../../../shared/sessions.js";
import { safeHref } from "../../../shared/url.js";
import { Icon, type IconName } from "../shell/icons.js";
import { age, useJson } from "../shell/live.js";

export const STATUS: Record<
  AgentSessionStatus,
  { label: string; icon: IconName }
> = {
  running: { label: "Running", icon: "play" },
  needs_you: { label: "Needs you", icon: "alert" },
  idle: { label: "Waiting", icon: "pause" },
  done: { label: "Done", icon: "check" },
};

/** Where a session runs and what it touches, as one quiet line. */
export function sessionMeta(session: AgentSessionView): string {
  const pr = session.prUrl?.match(/\/pull\/(\d+)/)?.[1];
  return [
    STATUS[session.status].label,
    session.location === "cloud" ? "Cloud" : session.location && "Local",
    session.machine,
    session.branch,
    pr ? `PR ${pr}` : session.prUrl && "PR",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The project page's agent sessions: active ones, then those done today. */
export function SessionsSection({ projectId }: { projectId: string }) {
  const { data, error } = useJson<{ sessions: AgentSessionView[] }>(
    `/api/browser/kim/projects/${encodeURIComponent(projectId)}/sessions`,
  );
  if (error) return <p className="kim-sessions-quiet">{error}</p>;
  if (!data) return <p className="kim-sessions-quiet">Loading…</p>;
  const { sessions } = data;
  const active = sessions.filter((session) => session.status !== "done");
  return (
    <div className="kim-sessions">
      <p className="kim-sessions-summary">
        {active.length} active · {sessions.length - active.length} done today
      </p>
      {!sessions.length && (
        <p className="kim-sessions-quiet">
          No sessions yet. Run <code>kim hooks install</code> so Claude Code
          sessions report here.
        </p>
      )}
      {sessions.map((session) => (
        <div
          key={session.id}
          className={`kim-sessions-row kim-sessions-${session.status}`}
        >
          <Icon
            name={STATUS[session.status].icon}
            label={STATUS[session.status].label}
            className="kim-sessions-status"
          />
          <span className="kim-sessions-main">
            <span className="kim-sessions-title">
              {session.title ?? "Untitled session"}
            </span>
            <span className="kim-sessions-meta">{sessionMeta(session)}</span>
            {session.brief && session.status !== "running" && (
              <span className="kim-sessions-brief">{session.brief}</span>
            )}
            {safeHref(session.url) && (
              <a
                className="kim-sessions-request"
                href={safeHref(session.url)}
                target="_blank"
                rel="noreferrer"
              >
                Open session →
              </a>
            )}
            {session.requests.map((request) => (
              <a
                key={request.id}
                className="kim-sessions-request"
                href={`/s/${request.token}`}
              >
                {request.open > 0 ? <b>Request</b> : "Request"}: {request.title}
                {request.open > 0
                  ? ` · ${request.open} open`
                  : request.status === "stopped"
                    ? " · finished"
                    : " · answered"}
              </a>
            ))}
          </span>
          <span className="kim-sessions-age" title={session.statusSince}>
            {age(session.statusSince)}
          </span>
        </div>
      ))}
    </div>
  );
}
