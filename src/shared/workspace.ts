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
 * How an artifact renders. Diagrams are HTML or SVG; anything else is shown
 * as text.
 */
export function artifactFormat(
  kind: ArtifactKind,
  content: string,
): ArtifactFormat {
  if (kind === "plan" || kind === "document") return "markdown";
  // Served as the design viewer's page, built from the design's source.
  if (kind === "design" || kind === "tokens") return "html";
  if (kind === "mockup" || /^\s*(<!doctype html|<html)/i.test(content))
    return "html";
  if (/^\s*(<\?xml|<svg)/i.test(content)) return "svg";
  return "text";
}

/** An html artifact's page, at its current revision. */
export function artifactViewUrl(token: string, artifact: ArtifactView): string {
  const params = new URLSearchParams({ rev: String(artifact.revision) });
  if (artifact.tokensRevision)
    params.set("tokens", String(artifact.tokensRevision));
  return `/api/browser/${token}/artifacts/${artifact.id}/view?${params}`;
}

/** Plans and documents are a page wide, and at least a page tall. */
export const PAGE_WIDTH = 620;
export const PAGE_HEIGHT = 760;

export interface FrameSize {
  w: number;
  /** Null for documents, which are as tall as their text. */
  h: number | null;
}

/**
 * The size a frame shows an artifact at. Mockups are desktop pages unless
 * their title or description says phone or tablet; documents are a page.
 */
export function frameSize(artifact: ArtifactView): FrameSize {
  if (artifact.format === "markdown" || artifact.format === "text")
    return { w: PAGE_WIDTH, h: null };
  const words = `${artifact.title} ${artifact.description ?? ""}`;
  if (artifact.format === "html" && /\b(mobile|phone)\b/i.test(words))
    return { w: 390, h: 844 };
  if (artifact.format === "html" && /\b(tablet|ipad)\b/i.test(words))
    return { w: 834, h: 1112 };
  return { w: 1280, h: 800 };
}
