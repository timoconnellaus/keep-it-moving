// Builds docs/marketing/keep-it-moving.html from base.html (the page before the demo) and the captured app,
// with the app's CSS from web-dist (run `npm run build:web` first). Builds the marketing page: the hero demo is the real app (captured DOM + built CSS) in a srcdoc iframe.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const postcss = createRequire(REPO + "/package.json")("postcss");
const page = readFileSync(`${HERE}/base.html`, "utf8");
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

let out = page;
const cut = (from, to, replacement = "") => {
  const a = out.indexOf(from); const b = out.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error("missing " + from);
  out = out.slice(0, a) + replacement + out.slice(b + to.length);
};
// Hero: no tiles; a calm grid behind the heading instead.
cut("/* Floating interview fragments", "@media (prefers-reduced-motion: no-preference) {\n  .tile { animation: float 6s ease-in-out infinite; }\n  .t2 { animation-delay: -1.5s; }", "/* A soft grid behind the hero, fading out towards the edges and the demo. */\n.hero::before { content: \"\"; position: absolute; z-index: 0; inset: 0 calc(-1 * clamp(18px, 4vw, 56px)); pointer-events: none; background-image: linear-gradient(to right, #0e0f110c 1px, transparent 1px), linear-gradient(to bottom, #0e0f110c 1px, transparent 1px); background-size: 44px 44px; background-position: center top; -webkit-mask-image: radial-gradient(ellipse 70% 62% at 50% 22%, #000 30%, transparent 78%); mask-image: radial-gradient(ellipse 70% 62% at 50% 22%, #000 30%, transparent 78%); }\nREMOVE-ME");
cut("REMOVE-ME", "  .frag.chip i { animation: pulse 1.1s ease-in-out infinite; }\n}\n");
cut("  .t1, .t4, .t2, .t5 { display: none; }\n", "  .t3 { top: 590px; left: -40px; } .t6 { top: 590px; right: -40px; }\n");
cut("  .tiles {", " display: none; }\n");
cut('        <div class="tiles" aria-hidden="true">', "        </div>\n\n");

// The demo's styles: the frame and a browser bar; the app inside brings its own.
cut("/* Product demo: a 1240×760 app window", ".demo-caption {", `/* Product demo: the real app at 1440×860 in an iframe, under a browser bar, scaled to fit and played by the script at the end */
.demo-frame { position: relative; z-index: 3; margin: 72px auto 0; max-width: 1080px; border-radius: 18px 18px 0 0; overflow: hidden; border: 1px solid var(--line); border-bottom: 0; box-shadow: 0 -24px 70px -34px #8d95a3; background: var(--card); }
.demo-stage { position: absolute; top: 0; left: 0; width: 1440px; height: 904px; transform-origin: 0 0; background: var(--card); }
.demo-chrome { display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 18px; border-bottom: 1px solid var(--line); }
.demo-chrome .url { max-width: 440px; font-size: 13px; }
.demo-stage iframe { display: block; width: 1440px; height: 860px; border: 0; pointer-events: none; }
.demo-caption {`);
const frameStart = out.indexOf('        <div class="demo-frame" id="demo"');
const frameEnd = out.indexOf("\n      </div>\n    </div>\n  </div>\n\n  <!-- Features -->");
const label = out.slice(frameStart, out.indexOf(">", frameStart) + 1);
out = out.slice(0, frameStart) + `${label}
          <div class="demo-stage" id="stage" aria-hidden="true">
            <div class="demo-chrome"><span class="dots"><i></i><i></i><i></i></span><span class="url">keep-it-moving.zerobsai.com/s/8Sjn9R</span></div>
            <iframe id="demo-app" title="Keep it moving" tabindex="-1" inert></iframe>
          </div>
        </div>` + out.slice(frameEnd);

// The script: replace the old demo player.
const player = readFileSync(`${HERE}/player.js`, "utf8");
const s = out.indexOf("<script>\n// The product demo");
const e = out.indexOf("</script>", s) + "</script>".length;
if (s < 0) throw new Error("old player not found");
out = out.slice(0, s) + `<script type="text/html" id="demo-doc">${doc}</script>
<script src="https://cdn.jsdelivr.net/npm/morphdom@2.7.8/dist/morphdom-umd.min.js"></script>
<script>
${player}</script>` + out.slice(e);
writeFileSync(`${HERE}/../keep-it-moving.html`, out);
console.log("wrote", out.length, "bytes; app document", doc.length);
