import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * `kim inbox screenshot`, on this machine: an html or svg artifact, as its
 * frame serves it, rendered in a Chrome, Edge or Chromium already
 * installed here, driven headless over the DevTools protocol on a pipe (no
 * port, no dependency). The page is served to the browser from memory with
 * the same sandbox headers the site's frame uses, so its scripts run in an
 * opaque origin that can't reach this machine's other pages or files.
 */

export interface RenderInput {
  format: "html" | "svg";
  content: string;
  width: number;
  /** The frame's height, which the viewport starts at. */
  height: number;
  fullPage: boolean;
}

/** A full page is cut off here: a screenshot past this is no use to read. */
const MAX_HEIGHT = 16_384;
/** How long a render may take, launch to capture. */
const RENDER_MS = 30_000;
/**
 * The site's frame serves artifacts with these (ARTIFACT_VIEW_HEADERS in
 * server/artifactView.ts, not imported so the CLI package stays small): an
 * opaque origin for scripts, and no referrer on what the page loads.
 */
const SANDBOX_HEADERS = {
  "content-security-policy": "sandbox allow-scripts",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
/** Where the page appears to come from. It never reaches the network. */
const PAGE_URL = "http://artifact.localhost/";

/** Waits for the page's fonts, then measures how tall it is. */
const SETTLE_AND_MEASURE = `(async () => {
  if (document.fonts) await document.fonts.ready;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
})()`;

/** No browser to render with: the caller says what to do instead. */
export class NoBrowser extends Error {}

/** Chromium-family browsers kim can drive, most likely first. */
function candidates(): string[] {
  const home = homedir();
  if (process.platform === "darwin")
    return [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Chromium.app/Contents/MacOS/Chromium",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Brave Browser.app/Contents/MacOS/Brave Browser",
      "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ].flatMap((app) => [
      join("/Applications", app),
      join(home, "Applications", app),
    ]);
  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter((root): root is string => Boolean(root));
    return [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "Chromium\\Application\\chrome.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ].flatMap((exe) => roots.map((root) => join(root, exe)));
  }
  const onPath = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser",
    "chrome",
    "chrome-headless-shell",
  ].flatMap((name) => {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    return found.status === 0 ? [found.stdout.trim()] : [];
  });
  // Browsers Playwright and Puppeteer downloaded, common in cloud sessions.
  const cached = (dir: string, inner: string[]) => {
    try {
      return readdirSync(dir)
        .sort()
        .reverse()
        .flatMap((version) => inner.map((path) => join(dir, version, path)));
    } catch {
      return [];
    }
  };
  return [
    ...onPath,
    ...cached(join(home, ".cache", "ms-playwright"), [
      "chrome-linux/chrome",
      "chrome-linux64/chrome",
      "chrome-headless-shell-linux64/chrome-headless-shell",
    ]),
    ...cached(join(home, ".cache", "puppeteer", "chrome"), [
      "chrome-linux64/chrome",
    ]),
    ...cached(join(home, ".cache", "puppeteer", "chrome-headless-shell"), [
      "chrome-headless-shell-linux64/chrome-headless-shell",
    ]),
  ];
}

const runnable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The browser to render with: KIM_BROWSER if set, else the first found. */
export function findBrowser(env = process.env): string {
  const chosen = env.KIM_BROWSER;
  if (chosen) {
    if (runnable(chosen)) return chosen;
    throw new NoBrowser(`KIM_BROWSER (${chosen}) isn't a browser kim can run`);
  }
  const found = candidates().find(runnable);
  if (!found)
    throw new NoBrowser(
      "No Chrome, Edge or Chromium found on this machine (set KIM_BROWSER to one)",
    );
  return found;
}

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

/** The DevTools protocol over --remote-debugging-pipe: JSON, NUL-separated. */
function devtools(input: Writable, output: Readable) {
  let next = 1;
  let buffer = "";
  const waiting = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  const listeners = new Set<(message: Message) => void>();
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)) as Message;
      buffer = buffer.slice(end + 1);
      if (message.id !== undefined) {
        const pending = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result ?? {});
      } else for (const listen of listeners) listen(message);
    }
  });
  return {
    send(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ): Promise<Record<string, unknown>> {
      const id = next++;
      input.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
      return new Promise((resolve, reject) =>
        waiting.set(id, { resolve, reject }),
      );
    },
    on(listen: (message: Message) => void) {
      listeners.add(listen);
    },
    fail(error: Error) {
      for (const pending of waiting.values()) pending.reject(error);
      waiting.clear();
    },
  };
}

/**
 * One render in a fresh headless browser, laid out at exactly `width` (as
 * the canvas frames it), after its fonts load, and with `fullPage` as tall
 * as the page. The browser and its profile go however it ends.
 */
export async function renderScreenshot(
  input: RenderInput,
  browser = findBrowser(),
): Promise<{ png: Buffer; height: number }> {
  const profile = mkdtempSync(join(tmpdir(), "kim-browser-"));
  const child = spawn(
    browser,
    [
      "--headless",
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      // Chrome refuses its sandbox as root, as in most containers.
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });
  const pipeIn = child.stdio[3] as Writable;
  const pipeOut = child.stdio[4] as Readable;
  // A browser that died closes the pipe; the exit says why.
  pipeIn.on("error", () => undefined);
  pipeOut.on("error", () => undefined);
  const cdp = devtools(pipeIn, pipeOut);
  const exited = new Promise<never>((_, reject) => {
    child.once("error", (error) =>
      reject(new Error(`${browser} didn't start: ${error.message}`)),
    );
    child.once("exit", (code) =>
      reject(
        new Error(
          `${browser} exited (${code ?? "signal"}) before the screenshot${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`,
        ),
      ),
    );
  });
  exited.catch((error: Error) => cdp.fail(error));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      capture(cdp, input),
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The page took too long to render")),
          RENDER_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    child.removeAllListeners("exit");
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      void cdp.send("Browser.close").catch(() => undefined);
      const kill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await gone;
      clearTimeout(kill);
    }
    rmSync(profile, { recursive: true, force: true });
  }
}

async function capture(
  cdp: ReturnType<typeof devtools>,
  input: RenderInput,
): Promise<{ png: Buffer; height: number }> {
  const { targetId } = (await cdp.send("Target.createTarget", {
    url: "about:blank",
  })) as { targetId: string };
  const { sessionId } = (await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  })) as { sessionId: string };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    cdp.send(method, params, sessionId);
  const headers = {
    ...SANDBOX_HEADERS,
    "content-type":
      input.format === "svg"
        ? "image/svg+xml; charset=utf-8"
        : "text/html; charset=utf-8",
  };
  const body = Buffer.from(input.content, "utf8").toString("base64");
  let loaded: () => void;
  const load = new Promise<void>((resolve) => (loaded = resolve));
  cdp.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Fetch.requestPaused")
      void send("Fetch.fulfillRequest", {
        requestId: message.params!.requestId,
        responseCode: 200,
        responseHeaders: Object.entries(headers).map(([name, value]) => ({
          name,
          value,
        })),
        body,
      }).catch(() => undefined);
    if (message.method === "Page.loadEventFired") loaded();
  });
  let height = input.height;
  const viewport = () =>
    send("Emulation.setDeviceMetricsOverride", {
      width: input.width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  await viewport();
  await send("Fetch.enable", { patterns: [{ urlPattern: PAGE_URL }] });
  await send("Page.enable");
  await send("Page.navigate", { url: PAGE_URL });
  await load;
  const measured = (await send("Runtime.evaluate", {
    expression: SETTLE_AND_MEASURE,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  const full = Number(measured.result?.value);
  if (input.fullPage && Number.isFinite(full)) {
    const tall = Math.min(Math.max(height, full), MAX_HEIGHT);
    if (tall !== height) {
      height = tall;
      await viewport();
    }
  }
  const { data } = (await send("Page.captureScreenshot", {
    format: "png",
  })) as { data: string };
  return { png: Buffer.from(data, "base64"), height };
}
