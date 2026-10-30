import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { sha256 } from "../server/keys.js";
import { screenshotRefusal } from "../server/plans.js";
import type { Env } from "./env.js";
import { planOf } from "./plans.js";
import type { Refused } from "./screenshotBudget.js";

/**
 * `kim inbox screenshot`: an html or svg artifact, as its frame serves it,
 * rendered to a PNG in one of Cloudflare's browsers (Browser Run). Each
 * PNG is kept in R2 under what it shows, so asking again opens no browser;
 * a lifecycle rule on the bucket drops them after a while. New renders
 * stay inside the plan's included browser time (see screenshotBudget.ts).
 */

/** The served artifact, as `kim inbox artifact` returns it. */
interface ServedArtifact {
  id: string;
  title: string;
  format: string;
  revision: number;
  frame: { width: number; height: number | null };
  content: string;
}

/** A full page is cut off here: a screenshot past this is no use to read. */
const MAX_HEIGHT = 16_384;
/** How long a render may hold a browser, launch to capture. */
const RENDER_MS = 30_000;
/** The page's own load, inside that. */
const LOAD_MS = 20_000;

/** Waits for the page's fonts, then measures how tall it is. */
const SETTLE_AND_MEASURE = `(async () => {
  if (document.fonts) await document.fonts.ready;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
})()`;

const REFUSALS: Record<Refused, { status: number; error: string }> = {
  paused: {
    status: 503,
    error:
      "Screenshots are paused until next month: this month's browser time is used up. Meanwhile `kim inbox artifact <interview> <artifact> --out <file>` saves the page itself.",
  },
  daily: {
    status: 429,
    error:
      "That's today's screenshots used up for your account; more tomorrow (UTC). Meanwhile `kim inbox artifact <interview> <artifact> --out <file>` saves the page itself.",
  },
  busy: {
    status: 429,
    error: "Other screenshots are rendering; try again in a few seconds.",
  },
};

/**
 * Answers `GET …/artifacts/:id/screenshot?width=N&fullPage=1` for someone
 * the inbox already let in; `served` fetches the artifact from its hub.
 */
export async function screenshot(
  request: Request,
  env: Env,
  email: string,
  token: string,
  served: () => Promise<Response>,
): Promise<Response> {
  if ((await planOf(env, email)) === "free")
    return Response.json(screenshotRefusal(env.PUBLIC_URL), { status: 402 });
  const response = await served();
  if (!response.ok) return response;
  const artifact = (await response.json()) as ServedArtifact;
  if (artifact.format !== "html" && artifact.format !== "svg")
    return Response.json(
      {
        error: `"${artifact.title}" is ${artifact.format}, not a page; read it with kim inbox artifact`,
      },
      { status: 400 },
    );
  const query = new URL(request.url).searchParams;
  const width = Number(query.get("width") ?? artifact.frame.width);
  if (!Number.isInteger(width) || width < 100 || width > 4_000)
    return Response.json(
      { error: "--width is a number of pixels, such as 1280, 834 or 390" },
      { status: 400 },
    );
  const fullPage = query.get("fullPage") === "1";
  // Revision and content both: an answer bound to the page changes it too.
  const key = `screenshots/${token}/${artifact.id}/r${artifact.revision}-${(await sha256(artifact.content)).slice(0, 16)}-${width}${fullPage ? "-full" : ""}.png`;
  const headers = (height: number, cache: "hit" | "miss") => ({
    "content-type": "image/png",
    "cache-control": "private, no-store",
    "x-kim-width": String(width),
    "x-kim-height": String(height),
    "x-kim-revision": String(artifact.revision),
    "x-kim-cache": cache,
  });
  const kept = await env.SCREENSHOTS.get(key);
  if (kept)
    return new Response(kept.body, {
      headers: headers(Number(kept.customMetadata?.height ?? 0), "hit"),
    });
  const budget = env.SCREENSHOT_BUDGET.get(
    env.SCREENSHOT_BUDGET.idFromName("ledger"),
  );
  const begun = await budget.begin(email);
  if (!begun.ok) {
    const { status, error } = REFUSALS[begun.refused];
    return Response.json(
      { error, code: `screenshot_${begun.refused}` },
      {
        status,
        headers: begun.refused === "busy" ? { "retry-after": "5" } : {},
      },
    );
  }
  const started = Date.now();
  let extra = 0;
  try {
    const shot = await render(env, artifact, width, fullPage).catch(
      (error: unknown) => {
        // Usually a close that didn't happen: the browser idles out after a minute.
        if (error instanceof CloseFailed) extra = 60_000;
        throw error;
      },
    );
    await env.SCREENSHOTS.put(key, shot.png, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { height: String(shot.height) },
    });
    return new Response(shot.png, { headers: headers(shot.height, "miss") });
  } catch (error) {
    return Response.json(
      {
        error: `The screenshot didn't render: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 },
    );
  } finally {
    await budget.end(begun.lease, Date.now() - started + extra);
  }
}

class CloseFailed extends Error {}

/**
 * One render in a fresh browser, laid out at exactly `width` (as the canvas
 * frames it: an iframe this wide, not a phone's layout viewport scaled
 * down), after its fonts load, and with `fullPage` as tall as the page.
 * The browser closes however it ends.
 */
async function render(
  env: Env,
  artifact: ServedArtifact,
  width: number,
  fullPage: boolean,
): Promise<{ png: Uint8Array; height: number }> {
  const browser = await puppeteer.launch(env.BROWSER);
  let result: { png: Uint8Array; height: number } | undefined;
  let failure: unknown;
  try {
    result = await withTimeout(
      capture(browser, artifact, width, fullPage),
      RENDER_MS,
      "The page took too long to render",
    );
  } catch (error) {
    failure = error;
  }
  try {
    await browser.close();
  } catch (error) {
    throw new CloseFailed(
      `the browser didn't close: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!result) throw failure;
  return result;
}

async function capture(
  browser: Browser,
  artifact: ServedArtifact,
  width: number,
  fullPage: boolean,
) {
  const page = await browser.newPage();
  page.setDefaultTimeout(LOAD_MS);
  let height = artifact.frame.height ?? 800;
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  if (artifact.format === "svg")
    await page.goto(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artifact.content)}`,
      { waitUntil: "load" },
    );
  else await page.setContent(artifact.content, { waitUntil: "load" });
  const measured = Number(await page.evaluate(SETTLE_AND_MEASURE));
  if (fullPage && Number.isFinite(measured)) {
    const full = Math.min(Math.max(height, measured), MAX_HEIGHT);
    if (full !== height) {
      height = full;
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
    }
  }
  const png = await page.screenshot({ type: "png" });
  return { png: new Uint8Array(png), height };
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
