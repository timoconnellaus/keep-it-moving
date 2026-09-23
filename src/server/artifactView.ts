import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** A tall page is cut here; the top of a mockup or diagram carries most of its meaning. */
const MAX_CAPTURE_HEIGHT = 2_000;

let captureScript: string | null = null;

/**
 * Runs inside the sandboxed artifact, which can read its own DOM but not the
 * page's, and answers the stage's capture requests with a JPEG of itself.
 */
function capture(): string {
  if (captureScript) return captureScript;
  const library = readFileSync(
    createRequire(import.meta.url).resolve(
      "html-to-image/dist/html-to-image.js",
    ),
    "utf8",
  );
  const listener = `
window.addEventListener("message", async (event) => {
  const request = event.data;
  if (!request || request.type !== "interviewer:capture") return;
  const reply = (body) => parent.postMessage({ type: "interviewer:capture-result", id: request.id, ...body }, "*");
  try {
    const root = document.documentElement;
    const url = await htmlToImage.toJpeg(root, {
      quality: 0.85,
      backgroundColor: "#ffffff",
      pixelRatio: 1,
      width: root.scrollWidth,
      height: Math.min(root.scrollHeight, ${MAX_CAPTURE_HEIGHT}),
    });
    reply({ url });
  } catch (error) {
    reply({ error: String(error) });
  }
});`;
  // "<\/" keeps a "</script>" inside the code from ending the tag early.
  captureScript = `<script>${`${library}\n${listener}`.replace(/<\//g, "<\\/")}</script>`;
  return captureScript;
}

/** Artifact HTML with the capture listener appended to its body. */
export function capturableDocument(html: string): string {
  const script = capture();
  // A replacer function, because the library source contains "$" patterns.
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${script}</body>`)
    : `${html}${script}`;
}

/**
 * Serves the document as its own sandbox, even if opened directly: scripts
 * run with an opaque origin that can't read or write the local API, and
 * requests it makes carry no referrer (which would include the session token).
 */
export const ARTIFACT_VIEW_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "sandbox allow-scripts",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
};
