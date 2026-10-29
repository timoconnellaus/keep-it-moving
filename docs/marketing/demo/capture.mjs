// Drives the real app through the demo's story and saves the .shell DOM at each step.
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Needs `wrangler dev --local --host localhost --port 8787` with DEV_EMAIL, and a CLI signed in to it under
// KIM_HOME (HOME for the kim config). Writes states.json and a screenshot per state into SCRATCH.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const SCRATCH = process.env.SCRATCH ?? HERE;
const BASE = "http://localhost:8787";
const env = { ...process.env, HOME: process.env.KIM_HOME ?? process.env.HOME, KEEP_IT_MOVING_URL: BASE };
const kim = (...args) => execFileSync("node", [`${REPO}/dist/cli.js`, ...args], { env, encoding: "utf8" });
const kimJson = (...args) => JSON.parse(kim(...args));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waits = [];
const bgWait = () => { const p = spawn("node", [`${REPO}/dist/cli.js`, "wait", S, "--idle", "400", "--timeout", "600000"], { env, stdio: "ignore" }); const done = new Promise((r) => p.on("exit", r)); waits.push(p); return done; };

// Start clean: no other interviews (their open questions would put a badge on the switcher).
for (const s of kimJson("session", "list", "--all")) kim("session", "delete", s.id);

const session = kimJson("session", "create", "--title", "Checkout rework", "--project", "acme/storefront", "--open-stage");
const S = session.id, T = session.token;
kim("plan", S, "--file", `${HERE}/plan-1.md`);
const art = (file, title, description) => kimJson("artifact", "add", S, "--file", file, "--kind", "mockup", "--title", title, "--description", description).id;
const A = art(`${HERE}/layout-a.html`, "Layout A", "Layout A · one page");
const B = art(`${HERE}/layout-b.html`, "Layout B", "Layout B · two steps");
const q = (json) => kimJson("question", "add", S, "--json", JSON.stringify(json)).questions[0].id;
const Q1 = q({ type: "single-choice", prompt: "Payment provider", options: ["Stripe Checkout", "Paddle", "Our own card form"], default: ["Stripe Checkout"], recommendation: "Stripe hosts the card form, so PCI scope stays tiny." });
const Q2 = q({ type: "yes-no", prompt: "Guest checkout", default: ["Yes"], recommendation: "Forcing an account is the biggest single cause of drop-off." });
const Q3 = q({ type: "single-choice", prompt: "Which checkout layout?", options: ["One page", "Two steps"], optionArtifacts: { "One page": A, "Two steps": B }, default: ["One page"], recommendation: "One page keeps the order summary in view while people pay, and it's one fewer screen to drop off on." });
const answer = (id, text) => fetch(`${BASE}/api/browser/${T}/questions/${id}/answer`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ answer: text }) });
await answer(Q1, "Stripe Checkout"); await answer(Q2, "Yes");
kim("wait", S, "--idle", "300", "--timeout", "5000");
kim("chat", "reply", S, "--text", "I've drafted two checkout layouts. They're in the workspace.");
kim("artifact", "show", S, A);
let waiting = bgWait();

// Chrome at the demo's size.
const CH = process.env.CHROME ?? "/Users/tim/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CH, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(SCRATCH + "/chrome-")}`, "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {} await sleep(200); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");
await send("Page.navigate", { url: `${BASE}/s/${T}` });
await sleep(3500);

const states = {};
const capture = async (name) => {
  states[name] = await run(`(() => {
    const shell = document.querySelector(".shell").cloneNode(true);
    shell.querySelectorAll("script").forEach((n) => n.remove());
    shell.querySelectorAll("iframe").forEach((f) => {
      const m = (f.getAttribute("src") || "").match(/artifacts\\/([^/]+)\\/view/);
      f.removeAttribute("src");
      if (m) f.setAttribute("data-mock", m[1]);
    });
    return shell.outerHTML;
  })()`);
  await send("Page.captureScreenshot", { format: "png" }).then((s) => writeFileSync(`${SCRATCH}/cap-${name}.png`, Buffer.from(s.result.data, "base64")));
  console.log("captured", name, states[name].length);
};
const click = (selector, text) => run(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${JSON.stringify(text ?? "")} === "" || e.textContent.includes(${JSON.stringify(text ?? "")}) || e.getAttribute("aria-label") === ${JSON.stringify(text ?? "")}); if (!el) throw new Error("no " + ${JSON.stringify(selector + " " + (text ?? ""))}); el.click(); return true; })()`);

await capture("start");
await click(".choice-card-view", "View Two steps in the workspace"); await sleep(1500);
await capture("previewB");
await click(".choice-card-view", "View One page in the workspace"); await sleep(1500);
await capture("previewA");
await click(".question.emphasized .submit"); await waiting; await sleep(1500);
await capture("answered");
kim("plan", S, "--file", `${HERE}/plan-2.md`);
kim("artifact", "show", S, kimJson("session", "show", S).artifacts.find((a) => a.kind === "plan").id);
q({ type: "single-choice", prompt: "Where should tax be calculated?", options: ["Stripe Tax at checkout", "Our own rate table", "Prices include tax"], default: ["Stripe Tax at checkout"], recommendation: "You're on Stripe Checkout already, and Stripe Tax covers AU GST and EU VAT." });
q({ type: "single-choice", prompt: "Who sends receipts?", options: ["Stripe's receipt emails", "Our own emails"], default: ["Stripe's receipt emails"], recommendation: "Stripe sends them from your domain with your logo; no templates to keep." });
q({ type: "single-choice", prompt: "How are refunds made?", options: ["From the Stripe dashboard", "An admin page of our own"], default: ["From the Stripe dashboard"], recommendation: "Refunds are rare at this size; the dashboard covers them." });
waiting = bgWait(); await sleep(2000);
await capture("planned");
await run(`(() => { const t = document.querySelector(".chat textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, "Can guests save their address for next time?"); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
await sleep(300);
await click(".chat-send"); await waiting; await sleep(1500);
await capture("asked");
kim("chat", "reply", S, "--text", "Yes. Stripe keeps it on the customer, so signing up later picks it up.");
waiting = bgWait(); await sleep(2000);
await capture("replied");
await click(".accept-all"); await waiting; await sleep(1500);
await capture("accepted");
kim("plan", S, "--file", `${HERE}/plan-3.md`);
kim("session", "stop", S); await sleep(2000);
await capture("finished");

writeFileSync(`${HERE}/states.json`, JSON.stringify({ A, B, states }, null, 1));
waits.forEach((p) => p.kill()); chrome.kill(); process.exit(0);
