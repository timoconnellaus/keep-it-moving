import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A local Chrome, Chromium or Edge for `kim inbox screenshot`: headless,
 * driven over the DevTools protocol with Node's own WebSocket, so no
 * driver and no npm package.
 */

/** What finding a browser looks at, so tests can stand in for the machine. */
export interface BrowserSearch {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists(path: string): boolean;
  /** The entries of a folder, or none. */
  list(dir: string): string[];
}

export const NO_BROWSER =
  "No Chrome, Chromium or Edge found to take the screenshot. Install one, or set CHROME_PATH to its executable; meanwhile `kim inbox artifact <interview> <artifact> --out <file>` saves the HTML itself.";

/** Playwright's Chrome for Testing builds, newest first. */
function playwrightBuilds(
  search: BrowserSearch,
  cache: string,
  inner: string[],
) {
  return search
    .list(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    .flatMap((build) => inner.map((path) => join(cache, build, path)));
}

/** Where browsers install, in the order to try them. */
export function browserCandidates(search: BrowserSearch): string[] {
  const { platform, env, home } = search;
  if (platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Chromium.app/Contents/MacOS/Chromium",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ];
    return [
      ...apps.map((app) => join("/Applications", app)),
      ...apps.map((app) => join(home, "Applications", app)),
      ...playwrightBuilds(search, join(home, "Library/Caches/ms-playwright"), [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      ]),
    ];
  }
  if (platform === "win32") {
    const roots = [
      env.PROGRAMFILES,
      env["PROGRAMFILES(X86)"],
      env.LOCALAPPDATA,
    ].filter((root): root is string => Boolean(root));
    return [
      "Google\\Chrome\\Application\\chrome.exe",
      "Chromium\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
    ].flatMap((path) => roots.map((root) => `${root}\\${path}`));
  }
  const names = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
  ];
  const path = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
    .split(delimiter)
    .filter(Boolean);
  return [
    ...names.flatMap((name) => path.map((dir) => join(dir, name))),
    "/snap/bin/chromium",
    ...playwrightBuilds(search, join(home, ".cache/ms-playwright"), [
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
    ]),
  ];
}

/** The browser to use: CHROME_PATH when set, else the first one installed. */
export function findBrowser(search: BrowserSearch): string | null {
  const chosen = search.env.CHROME_PATH;
  if (chosen) {
    if (!search.exists(chosen))
      throw new Error(`CHROME_PATH is ${chosen}, which doesn't exist`);
    return chosen;
  }
  return browserCandidates(search).find((path) => search.exists(path)) ?? null;
}

export const localSearch = (): BrowserSearch => ({
  platform: process.platform,
  env: process.env,
  home: process.env.HOME ?? process.env.USERPROFILE ?? "",
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
});

/** A full page is cut off here: a screenshot past this is no use to read. */
const MAX_HEIGHT = 16_384;
/** How long the browser gets to start, and the page to load. */
const START_MS = 20_000;
const LOAD_MS = 20_000;

/**
 * How the browser is started: headless, in a throwaway profile, with the
 * DevTools protocol on a port it picks and writes to DevToolsActivePort.
 * Its own --screenshot mode can't do a phone's width (new headless won't
 * lay a page out narrower than 500px), so kim drives it over the protocol
 * instead, with Node's own WebSocket.
 */
export function launchArgs(profile: string): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    // A fresh profile otherwise reaches for the macOS keychain (or the
    // desktop's password store), and asks the user about it.
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-sync",
    "--mute-audio",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ];
}

/** Waits for the page's fonts, then measures how tall it is. */
const SETTLE_AND_MEASURE = `(async () => {
  if (document.fonts) await document.fonts.ready;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
})()`;

/**
 * Renders a page file to a PNG at a frame's size, with a headless browser:
 * laid out at exactly `width`, after its fonts load, and with `fullPage`
 * as tall as the page.
 */
export async function screenshot(options: {
  browser: string;
  page: string;
  out: string;
  width: number;
  height: number;
  fullPage: boolean;
}): Promise<{ width: number; height: number }> {
  const profile = mkdtempSync(join(tmpdir(), "kim-chrome-"));
  const child = spawn(options.browser, launchArgs(profile), {
    stdio: "ignore",
  });
  let exited = false;
  const exit = new Promise<void>((resolve) =>
    child.on("exit", () => {
      exited = true;
      resolve();
    }),
  );
  let socket: WebSocket | null = null;
  try {
    const port = await devToolsPort(profile, () => exited);
    socket = new WebSocket(`ws://127.0.0.1:${port.port}${port.path}`);
    const devtools = protocol(socket);
    await devtools.opened;
    const { targetId } = await devtools.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await devtools.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const page = (method: string, params: object = {}) =>
      devtools.send(method, params, sessionId as string);
    const size = (height: number) =>
      page("Emulation.setDeviceMetricsOverride", {
        width: options.width,
        height,
        deviceScaleFactor: 1,
        // As the canvas frames it: an iframe this wide, not a phone's
        // 980px layout viewport scaled down.
        mobile: false,
      });
    await size(options.height);
    await page("Page.enable");
    const loaded = devtools.event("Page.loadEventFired", sessionId as string);
    await page("Page.navigate", { url: pathToFileURL(options.page).href });
    await withTimeout(loaded, LOAD_MS, "The page didn't finish loading");
    const measured = await page("Runtime.evaluate", {
      expression: SETTLE_AND_MEASURE,
      awaitPromise: true,
      returnByValue: true,
    });
    let height = options.height;
    if (options.fullPage) {
      const full = Number(
        (measured.result as { value?: unknown } | undefined)?.value,
      );
      if (Number.isFinite(full))
        height = Math.min(Math.max(height, full), MAX_HEIGHT);
      if (height !== options.height) await size(height);
    }
    const { data } = await page("Page.captureScreenshot", { format: "png" });
    writeFileSync(options.out, Buffer.from(String(data), "base64"));
    await devtools.send("Browser.close").catch(() => undefined);
    return { width: options.width, height };
  } finally {
    socket?.close();
    if (!exited) child.kill();
    // The browser writes its profile until it has gone.
    await withTimeout(exit, 5_000, "").catch(() => undefined);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A temp folder left behind is no reason to fail the screenshot.
    }
  }
}

/** The DevTools port and path the browser wrote into its profile. */
async function devToolsPort(profile: string, gone: () => boolean) {
  const file = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline) {
    if (gone()) throw new Error("The browser quit before it was ready");
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, "utf8").trim().split("\n");
      if (port && path) return { port: Number(port), path };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The browser didn't start in time");
}

type Result = Record<string, unknown>;

/** The DevTools protocol over one socket: commands, their results, and events. */
function protocol(socket: WebSocket) {
  let next = 0;
  const pending = new Map<
    number,
    { resolve(value: Result): void; reject(error: Error): void }
  >();
  const waiting: Array<{
    method: string;
    sessionId: string | undefined;
    resolve(): void;
  }> = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      sessionId?: string;
      result?: Result;
      error?: { message: string };
    };
    if (message.id !== undefined) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(message.error.message));
      else call?.resolve(message.result ?? {});
      return;
    }
    for (const [index, wait] of waiting.entries())
      if (
        wait.method === message.method &&
        wait.sessionId === message.sessionId
      ) {
        waiting.splice(index, 1);
        wait.resolve();
        break;
      }
  };
  return {
    opened: new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Couldn't reach the browser"));
    }),
    send(method: string, params: object = {}, sessionId?: string) {
      const id = ++next;
      return withTimeout(
        new Promise<Result>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          socket.send(
            JSON.stringify({
              id,
              method,
              params,
              ...(sessionId ? { sessionId } : {}),
            }),
          );
        }),
        LOAD_MS,
        `The browser didn't answer ${method}`,
      );
    },
    event(method: string, sessionId?: string) {
      return new Promise<void>((resolve) =>
        waiting.push({ method, sessionId, resolve }),
      );
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
