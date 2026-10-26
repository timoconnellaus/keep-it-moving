import type { InboxItem } from "../../../shared/inbox.js";
import { NotifyToggle } from "../../Notify.js";
import { useOverview } from "../../overview.js";
import { Switcher } from "../../Switcher.js";
import { Account } from "./Account.js";
import { useHiddenItems } from "./hidden.js";
import { Icon } from "./icons.js";
import { Inbox } from "./Inbox.js";
import { LiveVersion, useJson, useOverviewSocket } from "./live.js";
import { ProjectPage } from "./ProjectPage.js";
import { ProjectRail, type RailProject } from "./ProjectRail.js";
import { Link, usePath } from "./router.js";

/**
 * Keep it moving: the top bar, the project rail and the content, for every
 * path but an interview (/s/<token>). "/" is the inbox and /p/<id>/… a
 * project. The server's overview pings refetch everything shown.
 */
export function Shell() {
  const version = useOverviewSocket();
  return (
    <LiveVersion.Provider value={version}>
      <ShellContent version={version} />
    </LiveVersion.Provider>
  );
}

function ShellContent({ version }: { version: number }) {
  const path = usePath();
  const projects = useJson<{ projects: RailProject[] }>(
    "/api/browser/kim/projects",
  ).data?.projects;
  const items = useJson<{ items: InboxItem[] }>("/api/browser/kim/inbox").data
    ?.items;
  const sessions = useOverview(version);
  const { visible, done, snooze } = useHiddenItems(items ?? null);

  const running = (projects ?? []).reduce(
    (sum, project) => sum + (project.stats.running ?? 0),
    0,
  );
  const project = path.match(/^\/p\/([^/]+)\/?(.*)$/);
  return (
    <div className="kim-shell">
      <header className="kim-shell-top">
        <Link href="/" className="kim-shell-brand">
          <Icon name="grid" />
          <b>Keep it moving</b>
        </Link>
        {projects && (
          <span className="kim-shell-counts">
            {visible.length} need you · {running} running · {projects.length}{" "}
            project{projects.length === 1 ? "" : "s"}
          </span>
        )}
        <span className="kim-shell-spacer" />
        <NotifyToggle />
        <Switcher session={null} sessions={sessions} />
        <Account />
      </header>
      <div className="kim-shell-body">
        <ProjectRail
          projects={projects ?? null}
          inboxCount={visible.length}
          path={path}
        />
        <main className="kim-shell-content">
          {project ? (
            <ProjectPage
              key={project[1]}
              projectId={decodeURIComponent(project[1]!)}
              rest={project[2] ?? ""}
              projects={projects ?? null}
            />
          ) : path === "/" ? (
            <Inbox
              items={items ? visible : null}
              projects={projects ?? null}
              done={done}
              snooze={snooze}
            />
          ) : (
            <div className="kim-shell-page kim-shell-empty">
              <h1 className="kim-shell-detail-title">Nothing here</h1>
              <Link href="/">Back to the inbox</Link>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
