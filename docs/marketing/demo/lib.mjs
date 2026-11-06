// What every story's capture needs: a local Worker of its own, a kim CLI signed in to it, and a headless
// Chrome at the demo's size that snapshots the app's .shell, frames and all.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../..", import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

/**
 * A `wrangler dev` with its own storage under `dir`, so the capture never touches your local data, and
 * DEV_EMAIL signed in. `as(email)` restarts it as someone else on the same storage (an assignee answering).
 */
export async function startWorker(dir, email) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  let child = null;
  const start = async (who) => {
    child = spawn("npx", ["wrangler", "dev", "--local", "--host", "localhost", "--port", String(port), "--persist-to", `${dir}/state`,
      "--var", `DEV_EMAIL:${who}`, "--var", "PUBLIC_URL:http://localhost", "--var", `ADMIN_EMAILS:${email}`], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      if (/Ready on/.test(log)) { try { if ((await fetch(base + "/")).ok) return; } catch {} }
      if (child.exitCode !== null) break;
    }
    throw new Error("wrangler dev didn't start:\n" + log.slice(-2000));
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child.on("exit", r));
    child.kill("SIGINT");
    await Promise.race([exited, sleep(5000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  await start(email);
  return { base, stop, as: async (who) => { await stop(); await start(who); } };
}

/** kim, with a HOME of its own (nothing reaches your agents' config or your real login), signed in to `base`. */
export async function signedInKim(base, home) {
  mkdirSync(`${home}/bin`, { recursive: true });
  // `kim login` opens the sign-in page; here a no-op stands in for `open`, and fetch follows it instead.
  writeFileSync(`${home}/bin/open`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(`${home}/bin/xdg-open`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, KEEP_IT_MOVING_URL: base, KEEP_IT_MOVING_NO_AUTO_UPDATE: "1", PATH: `${home}/bin:${process.env.PATH}` };
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "APPDATA", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE", "CLAUDE_CODE_REMOTE_SESSION_ID"]) delete env[name];
  const login = spawn("node", [`${REPO}/dist/cli.js`, "login"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  login.stderr.on("data", (d) => (err += d));
  for (let i = 0; i < 100 && !/\/authorize\S+/.test(err); i++) await sleep(100);
  const url = err.match(/http\S+\/authorize\S+/)?.[0];
  if (!url) throw new Error("kim login printed no sign-in link:\n" + err);
  // DEV_EMAIL signs the browser in, so the authorize step goes straight back to kim's callback.
  await fetch(url, { redirect: "follow" });
  await new Promise((r) => login.on("exit", r));
  const kim = (...args) => execFileSync("node", [`${REPO}/dist/cli.js`, ...args], { env, encoding: "utf8", cwd: home });
  const kimIn = (cwd, ...args) => execFileSync("node", [`${REPO}/dist/cli.js`, ...args], { env, encoding: "utf8", cwd });
  if (!JSON.parse(kim("whoami")).signedIn) throw new Error("kim didn't sign in");
  const waits = [];
  return {
    env,
    kim,
    kimIn,
    json: (...args) => JSON.parse(kim(...args)),
    /** `kim wait` in the background, as an agent runs it; resolves when the batch comes. */
    wait: (session) => {
      const p = spawn("node", [`${REPO}/dist/cli.js`, "wait", session, "--idle", "400", "--timeout", "600000"], { env, stdio: "ignore" });
      waits.push(p);
      return new Promise((r) => p.on("exit", r));
    },
    close: () => waits.forEach((p) => p.kill()),
  };
}

const CHROMES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

/** Headless Chrome over the DevTools protocol, at the demo's 1440×860. */
export async function startChrome() {
  const path = CHROMES.find((p) => existsSync(p));
  if (!path) throw new Error("No Chrome found; set CHROME");
  const port = await freePort();
  const profile = mkdtempSync(`${tmpdir()}/kim-demo-chrome-`);
  const chrome = spawn(path, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 50 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {} await sleep(200); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const frameSessions = new Map(); // an out-of-process frame's id → its session
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") frameSessions.set(m.params.targetInfo.targetId, m.params.sessionId);
    if (m.method === "Target.detachedFromTarget") for (const [k, v] of frameSessions) if (v === m.params.sessionId) frameSessions.delete(k);
  };
  const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const evaluate = async (expression, extra = {}, sessionId) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...extra }, sessionId);
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1500));
    return r.result?.result?.value;
  };
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");
  await send("DOM.enable");

  /** A frame's document as a page of its own: stylesheets inlined, scripts gone, form state written into the markup. */
  const FRAME_DOC = `(() => {
    // A stylesheet from another origin (the design viewer's, in its sandboxed frame) can't be read here: name it, to fetch.
    const css = [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join("\\n"); } catch { return s.href ? "/*kim-fetch:" + s.href + "*/" : ""; } }).join("\\n");
    const root = document.documentElement.cloneNode(true);
    root.querySelectorAll("script, link[rel=stylesheet], link[rel=modulepreload], style").forEach((n) => n.remove());
    const style = document.createElement("style");
    style.textContent = css;
    (root.querySelector("head") || root).prepend(style);
    return "<!doctype html>" + root.outerHTML;
  })()`;

  const frameOf = async (selector) => {
    const found = await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
    const node = await send("DOM.describeNode", { objectId: found.result.result.objectId });
    return node.result?.node?.frameId;
  };
  const inFrame = async (frameId, expression) => {
    const oop = frameSessions.get(frameId);
    if (oop) return evaluate(expression, {}, oop);
    const world = await send("Page.createIsolatedWorld", { frameId, worldName: "snap" });
    return evaluate(expression, { contextId: world.result.executionContextId });
  };
  const fetched = new Map();
  const frameDoc = async (frameId) => {
    let html = await inFrame(frameId, FRAME_DOC);
    for (const [marker, href] of [...html.matchAll(/\/\*kim-fetch:(\S+?)\*\//g)]) {
      if (!fetched.has(href)) fetched.set(href, await (await fetch(href)).text());
      html = html.replace(marker, () => fetched.get(href).replace(/<\/style/gi, "<\\/style"));
    }
    return html;
  };

  const page = {
    send,
    /** Where `inner` (matched inside the frame `iframe`) is on the page: the frame's box, scaled as the app scales it. */
    whereIn: async (iframe, inner, fx = 0.5, fy = 0.5) => {
      const box = await evaluate(`(() => { const f = document.querySelector(${JSON.stringify(iframe)}); const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, s: r.width / f.offsetWidth }; })()`);
      const [x, y] = await inFrame(await frameOf(iframe), `(() => { const r = document.querySelector(${JSON.stringify(inner)}).getBoundingClientRect(); return [r.left + r.width * ${fx}, r.top + r.height * ${fy}]; })()`);
      return [box.x + x * box.s, box.y + y * box.s];
    },
    run: (expression) => evaluate(expression),
    goto: async (url, settle = 3000) => { await send("Page.navigate", { url }); await sleep(settle); },
    /** A real pointer move, so React's hover handlers run. */
    mouse: async (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }),
    clickAt: async (x, y) => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    },
    type: async (text) => { for (const ch of text) await send("Input.insertText", { text: ch }); },
    /** The centre of the first element matching `selector` (and containing `text`), in page pixels. */
    where: (selector, text = "", fx = 0.5, fy = 0.5) => evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => !${JSON.stringify(text)} || e.textContent.includes(${JSON.stringify(text)}) || e.getAttribute("aria-label") === ${JSON.stringify(text)});
      if (!el) throw new Error("no " + ${JSON.stringify(selector + " " + text)});
      const r = el.getBoundingClientRect();
      return [r.left + r.width * ${fx}, r.top + r.height * ${fy}];
    })()`),
    click: (selector, text = "") => evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => !${JSON.stringify(text)} || e.textContent.includes(${JSON.stringify(text)}) || e.getAttribute("aria-label") === ${JSON.stringify(text)});
      if (!el) throw new Error("no " + ${JSON.stringify(selector + " " + text)});
      el.click(); return true;
    })()`),
    screenshot: async (file) => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(file, Buffer.from(s.result.data, "base64")); },
    frameDoc,
    close: () => { ws.close(); chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} },
  };
  return page;
}

/**
 * A story's states and the frame documents they show. `snap(name)` keeps the page's `.shell` (or the
 * whole #root for pages without one) with each iframe's document saved once, by its hash, as `data-mock`.
 */
export function recorder(page, scratch, story) {
  const states = {};
  const mocks = {};
  const urls = {};
  const snap = async (name, { settle = 0 } = {}) => {
    if (settle) await sleep(settle);
    const count = await page.run(`(() => { const shell = document.querySelector(".shell") || document.getElementById("root").firstElementChild; shell.querySelectorAll("iframe").forEach((f, i) => f.setAttribute("data-snap", i)); return shell.querySelectorAll("iframe").length; })()`);
    const keys = [];
    for (let i = 0; i < count; i++) {
      const found = await page.send("Runtime.evaluate", { expression: `document.querySelector('iframe[data-snap="${i}"]')` });
      const node = await page.send("DOM.describeNode", { objectId: found.result.result.objectId });
      const frameId = node.result?.node?.frameId;
      if (!frameId) console.warn("no frame id", JSON.stringify(node).slice(0, 300));
      let html = "";
      try { if (frameId) html = await page.frameDoc(frameId); } catch (e) { console.warn("frame", i, e.message.slice(0, 200)); }
      const key = createHash("sha1").update(html).digest("hex").slice(0, 10);
      if (html) mocks[key] = html;
      keys.push(html ? key : "");
    }
    states[name] = await page.run(`(() => {
      const keys = ${JSON.stringify(keys)};
      const live = document.querySelector(".shell") || document.getElementById("root").firstElementChild;
      const shell = live.cloneNode(true);
      live.querySelectorAll("iframe[data-snap]").forEach((f) => f.removeAttribute("data-snap"));
      shell.querySelectorAll("script").forEach((n) => n.remove());
      // What a person typed lives in properties, not attributes.
      const fields = live.querySelectorAll("input, textarea");
      shell.querySelectorAll("input, textarea").forEach((el, i) => {
        const from = fields[i];
        if (!from) return;
        if (el.tagName === "TEXTAREA") el.textContent = from.value;
        else if (from.type === "checkbox" || from.type === "radio") from.checked ? el.setAttribute("checked", "") : el.removeAttribute("checked");
        else if (from.value) el.setAttribute("value", from.value); else el.removeAttribute("value");
      });
      shell.querySelectorAll("iframe").forEach((f) => {
        const key = keys[Number(f.getAttribute("data-snap"))];
        f.removeAttribute("data-snap");
        f.removeAttribute("src");
        f.removeAttribute("srcdoc");
        if (key) f.setAttribute("data-mock", key);
      });
      return shell.outerHTML;
    })()`);
    urls[name] = await page.run("location.pathname");
    await page.screenshot(`${scratch}/${story}-${name}.png`);
    console.log(`  ${story}/${name}`, states[name].length, "bytes,", keys.filter(Boolean).length, "frames");
  };
  return { snap, result: () => ({ states, mocks, urls }) };
}
