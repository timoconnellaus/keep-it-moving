import type {
  ArtifactFormat,
  ArtifactKind,
  DesignType,
} from "../shared/schema.js";
import { artifactFormat } from "../shared/workspace.js";
import { designPage } from "./designPage.js";
import { tokensPage, usesTokens, withTokens } from "./tokensPage.js";

/**
 * What an artifact's frame is built from. The service builds plain
 * interviews' pages; for an encrypted one it hands these over sealed, and
 * the page or the CLI builds it once they're opened.
 */
export interface FrameParts {
  kind: ArtifactKind;
  designType: DesignType | null;
  title: string;
  content: string;
  /** The format the client said it has, for a sealed artifact. */
  format: ArtifactFormat | null;
  /** The repo copy it is compared with; null when it wasn't pulled. */
  base: string | null;
  /** The interview's design system tokens (CSS), if it has them. */
  tokens: string | null;
}

/**
 * An artifact as its frame serves it: a design as the viewer's page with
 * its source and repo copy, the tokens as their page, and a mockup that
 * links the tokens with them inlined.
 */
export function framePage(parts: FrameParts): {
  format: ArtifactFormat;
  content: string;
} {
  if (parts.kind === "design")
    return {
      format: "html",
      content: designPage({
        type: parts.designType!,
        title: parts.title,
        source: parts.content,
        base: parts.base,
      }),
    };
  if (parts.kind === "tokens")
    return {
      format: "html",
      content: tokensPage(parts.title, parts.content, parts.base),
    };
  const format = parts.format ?? artifactFormat(parts.kind, parts.content);
  if (format === "html" && parts.tokens && usesTokens(parts.content))
    return { format, content: withTokens(parts.content, parts.tokens) };
  return { format, content: parts.content };
}
