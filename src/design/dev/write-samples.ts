/// <reference types="node" />
/**
 * Writes a shell page per sample design (as the Worker serves them) plus an
 * index that frames them all, for looking at the viewer by hand:
 *
 *   npm run build:web
 *   npx tsx src/design/dev/write-samples.ts <dir>
 *   ln -s "$PWD/web-dist/design-viewer" <dir>/design-viewer
 *   (serve <dir> with `content-security-policy: sandbox allow-scripts` on the html)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { DesignShell } from "../types.js";
import { SAMPLES } from "./samples.js";

export function shellHtml(shell: DesignShell): string {
  const json = JSON.stringify(shell).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/design-viewer/viewer.css">
<script type="module" src="/design-viewer/viewer.js"></script></head>
<body><script type="application/json" id="kim-design">${json}</script>
<main id="kim-design-root"></main></body></html>
`;
}

const dir = process.argv[2];
if (!dir) throw new Error("usage: write-samples.ts <dir>");
mkdirSync(join(dir, "samples"), { recursive: true });
for (const [name, shell] of Object.entries(SAMPLES))
  writeFileSync(join(dir, "samples", `${name}.html`), shellHtml(shell));
const frames = Object.keys(SAMPLES)
  .map(
    (name) =>
      `<h2>${name} <span id="c-${name}"></span></h2><iframe name="${name}" src="samples/${name}.html" sandbox="allow-scripts" width="1280" height="720"></iframe>`,
  )
  .join("\n");
writeFileSync(
  join(dir, "samples", "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Design viewer samples</title>
<style>body{font-family:system-ui;margin:20px;background:#e8eaed}iframe{border:1px solid #ccc;background:#fff;display:block}</style>
<label><input type="checkbox" id="compare" checked> Compare</label>
${frames}
<script>
addEventListener("message", (e) => {
  for (const f of document.querySelectorAll("iframe")) if (f.contentWindow === e.source)
    document.getElementById("c-" + f.name).textContent = JSON.stringify(e.data);
});
document.getElementById("compare").onchange = (e) => {
  for (const f of document.querySelectorAll("iframe")) f.contentWindow.postMessage({ type: "kim-compare", on: e.target.checked }, "*");
};
</script>
`,
);
process.stdout.write(
  `Wrote ${Object.keys(SAMPLES).length} samples to ${join(dir, "samples")}\n`,
);
