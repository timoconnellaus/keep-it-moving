// Rebuilds the hero demos in docs/marketing/keep-it-moving.html, the page's source: one iframe document holding
// the real app (each story's captured DOM from <story>/states.json, plus the built CSS from web-dist; run
// `npm run build:web` first) and the script that plays it. Everything else on the page is edited by hand.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const postcss = createRequire(REPO + "/package.json")("postcss");
const PAGE = `${HERE}/../keep-it-moving.html`;
const STORIES = ["answer", "design", "mockup", "ship", "share"];
const page = readFileSync(PAGE, "utf8");
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

const text = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) => text(s).replace(/"/g, "&quot;");
// A short stand-in for an interview's long private token, for the address bar.
const shortUrl = (path) => "keep-it-moving.zerobsai.com" + path.replace(/\/s\/([\w-]{6})[\w-]*/, "/s/$1");

const mocks = {};
const templates = [];
for (const story of STORIES) {
  const { order, states, mocks: frames, urls, ...meta } = JSON.parse(readFileSync(`${HERE}/${story}/states.json`, "utf8"));
  Object.assign(mocks, frames);
  for (const name of order) {
    const added = meta.added?.[name];
    templates.push(`<template data-story="${story}" data-state="${name}" data-url="${attr(shortUrl(urls[name]))}"${added ? ` data-added="${attr(JSON.stringify(added))}"` : ""}>${states[name]}</template>`);
  }
  delete meta.added;
  if (Object.keys(meta).length) templates.push(`<template data-meta="${story}">${text(JSON.stringify(meta))}</template>`);
}
// Each frame's document once, as text; the player hands it to the frames that show it.
for (const [key, html] of Object.entries(mocks)) templates.push(`<template data-mock="${key}">${text(html)}</template>`);

const demoCss = `
html, body { overflow: hidden; }
/* The canvas pans to what each state shows, as the app's fit does. */
.react-flow__viewport { transition: transform 0.6s ease; }
body { transition: opacity 0.35s ease; }
body.demo-out { opacity: 0; }
.demo-new { background: #fff3c4; border-radius: 5px; box-shadow: 0 0 0 4px #fff3c4; transition: background 1.2s ease, box-shadow 1.2s ease; }
.demo-new.demo-fade { background: transparent; box-shadow: 0 0 0 4px transparent; }
.home-row.demo-new { background: #fff8db; box-shadow: none; border-radius: 0; }
#demo-cursor { position: absolute; top: 0; left: 0; z-index: 100; width: 30px; height: 30px; pointer-events: none; transform: translate(1340px, 800px); transition: transform 0.9s cubic-bezier(0.45, 0, 0.2, 1); filter: drop-shadow(0 2px 3px #0004); }
#demo-cursor svg { width: 100%; height: 100%; transition: transform 0.12s; transform-origin: 20% 12%; }
#demo-cursor.press svg { transform: scale(0.82); }
.demo-ripple { position: absolute; z-index: 99; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%; background: #1f6bff40; animation: demo-ripple 0.5s ease-out forwards; pointer-events: none; }
@keyframes demo-ripple { from { transform: scale(0.2); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
/* 04 Ship: the pull request the written files go into. A drawing, not the app, so it looks like the page around it. */
#demo-pr { position: absolute; z-index: 60; left: 36px; bottom: 36px; width: 640px; font: 15px/1.5 Figtree, system-ui, sans-serif; color: #0e0f11; background: #fff; border: 1px solid #e4e6ea; border-radius: 22px; box-shadow: 0 40px 80px -30px #0e0f1166, 0 0 0 8px #0e0f110a; padding: 18px; display: grid; gap: 14px; opacity: 0; transform: translateY(40px); transition: opacity 0.5s ease, transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1); }
#demo-pr.on { opacity: 1; transform: none; }
#demo-pr .k { font-size: 13px; font-weight: 600; color: #676c74; text-transform: uppercase; letter-spacing: 0.05em; }
#demo-pr .h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
#demo-pr .h b { font: 600 20px Outfit, Figtree, sans-serif; letter-spacing: -0.01em; }
#demo-pr .h span:last-child { color: #676c74; font: 13px "JetBrains Mono", monospace; }
#demo-pr .st { background: #2fbf71; color: #fff; border-radius: 99px; padding: 2px 10px; font-size: 12px; font-weight: 600; }
#demo-pr .body { display: grid; grid-template-columns: minmax(0, 1fr) 210px; gap: 14px; align-items: start; }
#demo-pr .files { border: 1px solid #e4e6ea; border-radius: 14px; overflow: hidden; }
#demo-pr .file { display: flex; gap: 10px; align-items: center; padding: 10px 14px; font: 13px "JetBrains Mono", monospace; border-top: 1px solid #f0f1f3; opacity: 0; transform: translateX(-8px); transition: opacity 0.4s ease, transform 0.4s ease; }
#demo-pr .file:first-child { border-top: 0; }
#demo-pr .file.on { opacity: 1; transform: none; }
#demo-pr .file .d { margin-left: auto; font-size: 12px; white-space: nowrap; }
#demo-pr .plus { color: #1a8f52; } #demo-pr .minus { color: #d64545; }
#demo-pr .more { padding: 10px 14px; border-top: 1px solid #f0f1f3; color: #676c74; font-size: 13px; }
#demo-pr .svg { border: 1px solid #e4e6ea; border-radius: 14px; overflow: hidden; background: #fff; display: grid; }
#demo-pr .svg img { display: block; width: 100%; height: 150px; object-fit: contain; padding: 8px; }
#demo-pr .svg span { font: 12px "JetBrains Mono", monospace; color: #676c74; padding: 7px 10px; border-top: 1px solid #f0f1f3; }
`;
const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1440">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Figtree:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>${css}${demoCss}</style></head><body><div id="root"></div>
${templates.join("\n")}
<div id="demo-pr" aria-hidden="true"></div>
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
