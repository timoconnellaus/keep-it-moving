import puppeteer from "@cloudflare/puppeteer";
import { sha256 } from "../server/keys.js";
import { DESIGN_VIEWER_PATH } from "../server/designPage.js";
import type { Env } from "./env.js";

/**
 * `kim design write`'s preview of a design: the design viewer's page drawn
 * in one of Cloudflare's browsers (Browser Run), and the SVG it exports.
 * It goes into the repo beside the design, so a PR shows the picture. Each
 * SVG is kept in R2 under the design's content, so writing again opens no
 * browser. Renders share the screenshots' monthly browser time.
 */

/** The design as its frame serves it, from the hub. */
interface DesignPage {
  id: string;
  kind: string;
  revision: number;
  content: string;
}

export const DESIGN_SVG = /^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)\/svg$/;

const RENDER_MS = 30_000;

/** Waits for the viewer to draw, then asks it for the SVG. */
const EXPORT = `(async () => {
  const until = Date.now() + 20000;
  while (!document.documentElement.dataset.kimRendered && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const state = document.documentElement.dataset.kimRendered;
  if (state !== "ok") return { error: state === "error" ? "The design has an error; fix it in the interview" : "The viewer didn't finish drawing" };
  if (document.fonts) await document.fonts.ready;
  return { svg: await window.kimDesignSvg() };
})()`;

/**
 * Answers `GET /api/sessions/:id/artifacts/:artifact/svg` for the agent;
 * `page` fetches the design's page from the user's hub.
 */
export async function designSvg(
  env: Env,
  email: string,
  page: () => Promise<Response>,
): Promise<Response> {
  const response = await page();
  if (!response.ok) return response;
  const design = (await response.json()) as DesignPage;
  if (design.kind !== "design")
    return Response.json(
      { error: "Only a system design has an SVG preview" },
      { status: 400 },
    );
  // Fetched from this site, since the page isn't served from it here.
  const html = design.content.replaceAll(
    `"${DESIGN_VIEWER_PATH}`,
    `"${env.PUBLIC_URL}${DESIGN_VIEWER_PATH}`,
  );
  const key = `designs/${(await sha256(email)).slice(0, 16)}/${design.id}/${(await sha256(html)).slice(0, 24)}.svg`;
  const headers = { "content-type": "image/svg+xml; charset=utf-8" };
  const kept = await env.SCREENSHOTS.get(key);
  if (kept) return new Response(kept.body, { headers });
  const budget = env.SCREENSHOT_BUDGET.get(
    env.SCREENSHOT_BUDGET.idFromName("ledger"),
  );
  const begun = await budget.begin(email);
  if (!begun.ok)
    return Response.json(
      {
        error:
          begun.refused === "busy"
            ? "Other renders are running; try again in a few seconds"
            : "Previews are paused for now; the design itself is written",
        code: `svg_${begun.refused}`,
      },
      { status: begun.refused === "busy" ? 429 : 503 },
    );
  const started = Date.now();
  try {
    const svg = await render(env, html);
    await env.SCREENSHOTS.put(key, svg, {
      httpMetadata: { contentType: headers["content-type"] },
    });
    return new Response(svg, { headers });
  } catch (error) {
    return Response.json(
      {
        error: `The preview didn't render: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 },
    );
  } finally {
    await budget.end(begun.lease, Date.now() - started);
  }
}

async function render(env: Env, html: string): Promise<string> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(RENDER_MS);
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    const result = (await page.evaluate(EXPORT)) as {
      svg?: string;
      error?: string;
    };
    if (!result.svg) throw new Error(result.error ?? "No SVG came back");
    return result.svg;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
