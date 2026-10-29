#!/usr/bin/env node
/**
 * Writes web-dist/landing.html, the page signed-out visitors get at the site
 * root, from docs/marketing/keep-it-moving.html. That page is written for an
 * artifact host, which supplies the document around it, so this wraps it in
 * one of its own, and the install command names the deployment serving it.
 * Run after `vite build`, which empties web-dist.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const page = readFileSync(`${root}/docs/marketing/keep-it-moving.html`, "utf8");
const description =
  "When your coding agent needs decisions from you, it opens an interview in your browser, with its recommended answer already picked and a plan that updates as you go.";

writeFileSync(
  `${root}/web-dist/landing.html`,
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${description}">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<style>body { margin: 0; }</style>
<script>
  // Served by a deployment, install from that deployment.
  document.addEventListener("DOMContentLoaded", () => {
    const commands = document.getElementById("install-cmds");
    if (commands) commands.innerHTML = commands.innerHTML.replace("https://keep-it-moving.zerobsai.com", location.origin);
  });
</script>
</head>
<body>
${page}
</body>
</html>
`,
);
