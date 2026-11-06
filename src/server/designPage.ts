import type { DesignType } from "../shared/schema.js";

/** Where the design viewer's files are served, CORS-open for sandboxed frames. */
export const DESIGN_VIEWER_PATH = "/design-viewer/";

export interface DesignPageInput {
  type: DesignType;
  title: string;
  source: string;
  /** The repo copy it is compared with; null for a design made in the interview. */
  base: string | null;
}

/**
 * A design as its frame serves it: the viewer's page, with the design's
 * source and the repo copy as JSON for the viewer to draw. `<` is escaped
 * so the source can't close the script element.
 */
export function designPage(input: DesignPageInput): string {
  const data = JSON.stringify(input).replace(/</g, "\\u003c");
  const title = input.title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="${DESIGN_VIEWER_PATH}viewer.css">
<script type="module" src="${DESIGN_VIEWER_PATH}viewer.js"></script></head>
<body><script type="application/json" id="kim-design">${data}</script>
<main id="kim-design-root"></main></body></html>`;
}
