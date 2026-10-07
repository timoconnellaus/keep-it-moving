import type { CSSProperties } from "react";
import type { ProjectStats } from "../../../shared/inbox.js";
import type { ProjectView } from "../../../shared/schema.js";
import { Icon, type IconName } from "./icons.js";
import { Link } from "./router.js";

/** A project as GET /api/browser/kim/projects returns it. */
export type RailProject = ProjectView & { stats: ProjectStats };

const CI: Record<string, { icon: IconName; label: string }> = {
  green: { icon: "ciGreen", label: "CI green" },
  red: { icon: "ciRed", label: "CI failing" },
  pending: { icon: "ciPending", label: "CI running" },
};

/**
 * The inbox and every project, compactly: icons and numbers for what needs
 * Tim, what's running, PRs, CI, automations and the milestone. A project
 * shows only the numbers some feature gives it.
 */
export function ProjectRail({
  projects,
  inboxCount,
  path,
}: {
  projects: RailProject[] | null;
  inboxCount: number;
  path: string;
}) {
  return (
    <nav className="kim-shell-rail" aria-label="Projects">
      <Link
        href="/"
        className={`kim-shell-rail-inbox ${path === "/" ? "active" : ""}`}
        aria-current={path === "/" ? "page" : undefined}
      >
        <Icon name="inbox" />
        Inbox
        {inboxCount > 0 && (
          <span className="kim-shell-count">{inboxCount}</span>
        )}
      </Link>
      <div className="kim-shell-rail-head">Projects</div>
      {projects === null && <p className="kim-shell-quiet">Loading…</p>}
      {projects?.length === 0 && (
        <p className="kim-shell-quiet">
          Projects appear when an agent session reports in.
        </p>
      )}
      {projects?.map((project) => {
        const href = `/p/${project.id}`;
        const active = path === href || path.startsWith(`${href}/`);
        const { stats } = project;
        const milestone = stats.milestone;
        const ci = stats.ci ? CI[stats.ci] : undefined;
        return (
          <Link
            key={project.id}
            href={href}
            className={`kim-shell-rail-project ${active ? "active" : ""}`}
            aria-current={active ? "page" : undefined}
            style={{ "--project": project.color } as CSSProperties}
          >
            <span className="kim-shell-rail-name">
              <span className="kim-shell-swatch" aria-hidden="true" />
              <span className="kim-shell-rail-title">{project.name}</span>
              {Boolean(stats.needsYou) && (
                <span
                  className="kim-shell-needs"
                  title={`${stats.needsYou} need you`}
                >
                  <Icon name="alert" label="Needs you" />
                  {stats.needsYou}
                </span>
              )}
            </span>
            {milestone && (
              <span className="kim-shell-rail-milestone">
                <Icon name="flag" />
                {milestone.name}
              </span>
            )}
            <span className="kim-shell-rail-stats">
              {stats.running !== undefined && (
                <span title="Sessions running">
                  <Icon name="play" label="Running" />
                  {stats.running}
                </span>
              )}
              {stats.openPrs !== undefined && (
                <span title="Open PRs">
                  <Icon name="pr" label="Open PRs" />
                  {stats.openPrs}
                </span>
              )}
              {ci && (
                <span className={`kim-shell-ci-${stats.ci}`} title={ci.label}>
                  <Icon name={ci.icon} label={ci.label} />
                </span>
              )}
              {stats.heartbeat && (
                <span
                  className={`kim-shell-beat-${stats.heartbeat}`}
                  title={
                    stats.heartbeat === "alive"
                      ? "Automations alive"
                      : "An automation is down"
                  }
                >
                  <Icon
                    name="heartbeat"
                    label={
                      stats.heartbeat === "alive"
                        ? "Automations alive"
                        : "Automation down"
                    }
                  />
                </span>
              )}
              {milestone && milestone.total > 0 && (
                <span
                  className="kim-shell-bar"
                  title={`${milestone.done} of ${milestone.total} done`}
                >
                  <span
                    style={{
                      width: `${(milestone.done / milestone.total) * 100}%`,
                    }}
                  />
                </span>
              )}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
