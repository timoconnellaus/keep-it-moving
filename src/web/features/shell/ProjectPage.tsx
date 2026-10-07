import type { CSSProperties } from "react";
import { projectRoutes, projectSections } from "../registry.js";
import type { RailProject } from "./ProjectRail.js";
import { Link } from "./router.js";

/**
 * A project: its header, then each feature's section in two columns.
 * /p/<id>/<rest> goes to the first feature route that matches instead.
 */
export function ProjectPage({
  projectId,
  rest,
  projects,
}: {
  projectId: string;
  /** The path after /p/<id>/, or "" for the project itself. */
  rest: string;
  projects: RailProject[] | null;
}) {
  const project = projects?.find((candidate) => candidate.id === projectId);
  if (projects && !project)
    return (
      <div className="kim-shell-page kim-shell-empty">
        <h1 className="kim-shell-detail-title">No such project</h1>
        <Link href="/">Back to the inbox</Link>
      </div>
    );
  if (rest) {
    for (const route of projectRoutes) {
      const match = rest.match(route.pattern);
      if (match)
        return (
          <div className="kim-shell-page">
            <route.Component projectId={projectId} match={match} />
          </div>
        );
    }
    return (
      <div className="kim-shell-page kim-shell-empty">
        <h1 className="kim-shell-detail-title">Nothing here</h1>
        <Link href={`/p/${projectId}`}>Back to the project</Link>
      </div>
    );
  }
  const column = (which: "main" | "side") =>
    projectSections
      .filter((section) => section.column === which)
      .map((section) => (
        <section
          key={section.id}
          className="kim-shell-section"
          aria-label={section.title}
        >
          <h2 className="kim-shell-section-title">{section.title}</h2>
          <section.Component projectId={projectId} />
        </section>
      ));
  return (
    <div className="kim-shell-page">
      <div
        className="kim-shell-project-head"
        style={{ "--project": project?.color } as CSSProperties}
      >
        <span className="kim-shell-swatch large" aria-hidden="true" />
        <h1>{project?.name ?? "…"}</h1>
        {project && <span className="kim-shell-tag">{project.key}</span>}
      </div>
      <div
        className={`kim-shell-columns ${projectSections.some((section) => section.column === "side") ? "" : "single"}`}
      >
        <div className="kim-shell-column main">{column("main")}</div>
        <div className="kim-shell-column side">{column("side")}</div>
      </div>
    </div>
  );
}
