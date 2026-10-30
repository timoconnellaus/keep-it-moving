// Rebuilds the hero demo in docs/marketing/keep-it-moving.html, the page's source: the real app (captured DOM
// in states.json + the built CSS from web-dist; run `npm run build:web` first) in a srcdoc iframe, and the
// script that plays it. Everything else on the page is edited by hand.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const postcss = createRequire(REPO + "/package.json")("postcss");
const PAGE = `${HERE}/../keep-it-moving.html`;
const page = readFileSync(PAGE, "utf8");
const { A, B, states } = JSON.parse(readFileSync(`${HERE}/states.json`, "utf8"));
const cssFile = readdirSync(`${REPO}/web-dist/assets`).find((f) => f.endsWith(".css"));
const appCss = readFileSync(`${REPO}/web-dist/assets/${cssFile}`, "utf8");

// The cursor can't trigger :hover or :focus, so each such rule gets a twin on a class the script sets.
const root = postcss.parse(appCss);
root.walkRules((rule) => {
  const twins = rule.selectors.filter((s) => /:hover|:focus(?![-\w])/.test(s))
    .map((s) => s.replace(/:hover/g, ".demo-hover").replace(/:focus(?![-\w])/g, ".demo-focus"));
  if (twins.length) rule.selectors = [...rule.selectors, ...twins];
});
const css = root.toString();

const attr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mocks = { [A]: readFileSync(`${HERE}/layout-a.html`, "utf8"), [B]: readFileSync(`${HERE}/layout-b.html`, "utf8") };
const fix = (html) => html.replace(/ data-mock="([^"]+)"/g, (_, id) => {
  if (!mocks[id]) throw new Error("unknown artifact " + id);
  return ` srcdoc="${attr(mocks[id])}"`;
});
// The lines each plan revision added, from the plans the agent wrote, for the player to pick out.
const bullets = (n) => readFileSync(`${HERE}/plan-${n}.md`, "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
const newLines = (from, to) => bullets(to).filter((line) => !bullets(from).includes(line));
const added = { planned: newLines(1, 2), finished: newLines(2, 3) };
const order = ["start", "previewB", "previewA", "answered", "planned", "asked", "replied", "accepted", "finished"];
const demoCss = `
html, body { overflow: hidden; }
/* The canvas pans to what each state shows, as the app's fit does. */
.react-flow__viewport { transition: transform 0.6s ease; }
body { transition: opacity 0.4s ease; }
body.demo-out { opacity: 0; }
.demo-new { background: #fff3c4; border-radius: 5px; box-shadow: 0 0 0 4px #fff3c4; transition: background 1.2s ease, box-shadow 1.2s ease; }
.demo-new.demo-fade { background: transparent; box-shadow: 0 0 0 4px transparent; }
#demo-cursor { position: absolute; top: 0; left: 0; z-index: 100; width: 30px; height: 30px; pointer-events: none; transform: translate(1340px, 800px); transition: transform 0.9s cubic-bezier(0.45, 0, 0.2, 1); filter: drop-shadow(0 2px 3px #0004); }
#demo-cursor svg { width: 100%; height: 100%; transition: transform 0.12s; transform-origin: 20% 12%; }
#demo-cursor.press svg { transform: scale(0.82); }
.demo-ripple { position: absolute; z-index: 99; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%; background: #1f6bff40; animation: demo-ripple 0.5s ease-out forwards; pointer-events: none; }
@keyframes demo-ripple { from { transform: scale(0.2); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
`;
const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1440">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Figtree:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>${css}${demoCss}</style></head><body><div id="root">${fix(states.start)}</div>
${order.map((name) => `<template data-state="${name}"${added[name] ? ` data-added="${attr(JSON.stringify(added[name]))}"` : ""}>${fix(states[name])}</template>`).join("\n")}
<div id="demo-cursor" hidden><svg viewBox="0 0 26 26"><path d="M5 3l15 9.5-6.6 1.5 3.9 7.2-3 1.6-3.9-7.3L5 20z" fill="#0e0f11" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
</body></html>`;
if (/<\/script/i.test(doc)) throw new Error("the app document can't sit in a script block");

// Swap in the new app document and player, between markers that stay put.
const swap = (html, open, close, body) => {
  const a = html.indexOf(open);
  const b = html.indexOf(close, a + open.length);
  if (a < 0 || b < 0) throw new Error("missing " + open);
  return html.slice(0, a + open.length) + body + html.slice(b);
};
let out = swap(page, '<script type="text/html" id="demo-doc">', "</script>", doc);
out = swap(out, '<script src="https://cdn.jsdelivr.net/npm/morphdom@2.7.8/dist/morphdom-umd.min.js"></script>\n<script>\n', "</script>", readFileSync(`${HERE}/player.js`, "utf8"));
writeFileSync(PAGE, out);
console.log("wrote", out.length, "bytes; app document", doc.length);
