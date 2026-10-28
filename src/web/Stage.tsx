import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ArtifactView, SessionView } from "../shared/schema.js";
import { artifactViewUrl, shownArtifact } from "../shared/workspace.js";
import { svgImageUrl } from "./diagram.js";

const KIND_LABEL: Record<ArtifactView["kind"], string> = {
  plan: "Plan",
  document: "Doc",
  diagram: "Diagram",
  mockup: "Mockup",
};

export function Stage({
  token,
  session,
  expanded,
  onShow,
  onToggleExpanded,
  onClose,
}: {
  token: string;
  session: SessionView;
  expanded: boolean;
  onShow(artifactId: string): void;
  onToggleExpanded(): void;
  onClose(): void;
}) {
  const shown = shownArtifact(session);
  const imageUrl = useMemo(
    () =>
      shown?.format === "svg" && shown.content
        ? svgImageUrl(shown.content)
        : null,
    [shown?.format, shown?.content],
  );
  const source =
    shown && session.stage?.artifactId === shown.id
      ? session.stage.source
      : null;
  // Beside the questions, diagrams use archify's compact embed mode;
  // expanded, its full viewer with pan, zoom and tracing.
  const frameUrl =
    shown?.format === "html"
      ? artifactViewUrl(token, shown, {
          embed: shown.kind === "diagram" && !expanded,
        })
      : undefined;

  return (
    <aside className="stage" aria-label="Workspace">
      <div className="stage-bar">
        <div className="stage-tabs" role="tablist">
          {session.artifacts.map((artifact) => (
            <button
              key={artifact.id}
              role="tab"
              type="button"
              aria-selected={artifact.id === shown?.id}
              className={artifact.id === shown?.id ? "active" : ""}
              onClick={() => onShow(artifact.id)}
            >
              <span className="kind">{KIND_LABEL[artifact.kind]}</span>
              {artifact.title}
            </button>
          ))}
        </div>
        {source && source !== "user" && (
          <span className="stage-source">via agent</span>
        )}
        <button
          type="button"
          className="stage-expand"
          onClick={onToggleExpanded}
          title={expanded ? "Show questions (Esc)" : "Hide questions"}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
        <button
          type="button"
          className="stage-close"
          onClick={onClose}
          aria-label="Hide the workspace"
          title="Hide the workspace"
        >
          ×
        </button>
      </div>
      {shown && (
        <div className="stage-body" role="tabpanel" aria-label={shown.title}>
          {shown.description && shown.kind !== "plan" && (
            <p className="stage-description">{shown.description}</p>
          )}
          {shown.format === "html" ? (
            <iframe
              // A fresh frame per URL: re-pointing a loaded frame between
              // archify's embed and full viewers has left it blank.
              key={frameUrl}
              className="artifact-frame"
              title={shown.title}
              // No sandbox attribute: the server's CSP sandbox header isolates
              // the document (opaque origin, no popups, forms, or top-level
              // navigation), and some embedded browsers refuse to load
              // sandbox-attributed frames over the network.
              src={frameUrl}
            />
          ) : shown.format === "svg" && imageUrl ? (
            <div className="diagram">
              <img src={imageUrl} alt={shown.title} />
            </div>
          ) : shown.format === "text" ? (
            <div className="stage-error">
              <p>This diagram isn’t archify or SVG, so it’s shown as source.</p>
              <pre>{shown.content}</pre>
            </div>
          ) : (
            <article className="doc">
              <Markdown remarkPlugins={[remarkGfm]}>
                {shown.content ?? ""}
              </Markdown>
            </article>
          )}
        </div>
      )}
    </aside>
  );
}

/** A small preview for choosing between artifacts, such as layout mockups. */
export function ArtifactThumb({
  token,
  artifact,
}: {
  token: string;
  artifact: ArtifactView;
}) {
  if (artifact.format === "html")
    return (
      <div className="thumb" aria-hidden="true">
        <iframe
          title=""
          tabIndex={-1}
          // Isolated by the server's CSP sandbox header, as on the stage.
          src={artifactViewUrl(token, artifact, {
            embed: artifact.kind === "diagram",
          })}
        />
      </div>
    );
  if (artifact.format === "svg" && artifact.content)
    return (
      <div className="thumb thumb-diagram" aria-hidden="true">
        <div className="diagram">
          <img src={svgImageUrl(artifact.content)} alt="" />
        </div>
      </div>
    );
  return (
    <div className="thumb thumb-doc" aria-hidden="true">
      {artifact.title}
    </div>
  );
}
