import type {
  ArtifactFormat,
  ArtifactKind,
  ArtifactView,
  SessionView,
} from "./schema.js";

/** What the stage shows: the chosen artifact, else the plan, else the first artifact. */
export function shownArtifact(session: SessionView): ArtifactView | null {
  const chosen = session.stage
    ? session.artifacts.find((item) => item.id === session.stage!.artifactId)
    : undefined;
  return (
    chosen ??
    session.artifacts.find((item) => item.kind === "plan") ??
    session.artifacts[0] ??
    null
  );
}

/**
 * How an artifact renders. Diagrams are archify HTML or SVG; anything else,
 * such as Mermaid source from before archify, is shown as text.
 */
export function artifactFormat(
  kind: ArtifactKind,
  content: string,
): ArtifactFormat {
  if (kind === "plan" || kind === "document") return "markdown";
  if (kind === "mockup" || /^\s*(<!doctype html|<html)/i.test(content))
    return "html";
  if (/^\s*(<\?xml|<svg)/i.test(content)) return "svg";
  return "text";
}

/** Archify renders an embed mode without its viewer chrome, and a fixed theme. */
export function artifactViewUrl(
  token: string,
  artifact: ArtifactView,
  options: { embed?: boolean } = {},
): string {
  const params = new URLSearchParams({
    rev: String(artifact.revision),
    theme: "light",
  });
  if (options.embed) params.set("embed", "1");
  return `/api/browser/${token}/artifacts/${artifact.id}/view?${params}`;
}
