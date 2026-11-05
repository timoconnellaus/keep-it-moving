/**
 * Prepares a mockup's HTML for the panel, which can fetch nothing and runs
 * none of the mockup's scripts: Tailwind's CDN becomes the CSS for the
 * classes the page uses, compiled here; Lucide placeholders become their
 * SVG. Fonts come from the panel's bundled kit, and the panel removes
 * scripts and anything else that could act.
 */
import { themeFromPage } from "./tailwindConfig";

export interface Kit {
  compileTailwind(candidates: string[], extra?: string): Promise<string>;
  /** Lucide icon name → its SVG's inner markup. */
  lucide: Record<string, string>;
}

export interface PreparedMockup {
  html: string;
  /** Compiled Tailwind, or "" when the page doesn't use it. */
  css: string;
  /** What the panel can't show: such as "scripts" or images it couldn't fetch. */
  limits: string[];
}

const TAILWIND_SCRIPT =
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*(cdn\.tailwindcss\.com|@tailwindcss\/browser)[^"']*["'][^>]*>\s*<\/script>/i;
const TAILWIND_STYLE =
  /<style\b[^>]*type\s*=\s*["']text\/tailwindcss["'][^>]*>([\s\S]*?)<\/style>/gi;
const CLASS = /\bclass\s*=\s*(["'])([\s\S]*?)\1/gi;
const LUCIDE =
  /<(i|span)\b([^>]*?)\bdata-lucide\s*=\s*(["'])([\w-]+)\3([^>]*)>\s*<\/\1>/gi;

export async function prepareMockup(
  html: string,
  kit: Kit,
): Promise<PreparedMockup> {
  const limits: string[] = [];
  let page = html.replace(
    LUCIDE,
    (all, _tag, before: string, _q, name: string, after: string) => {
      const inner = kit.lucide[name];
      if (inner === undefined) return all;
      const attrs = `${before} ${after}`;
      const classes =
        /\bclass\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs)?.[2] ?? "";
      const rest = attrs.replace(/\bclass\s*=\s*(["'])[\s\S]*?\1/i, "").trim();
      return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-${name} ${classes}"${rest ? ` ${rest}` : ""}>${inner}</svg>`;
    },
  );
  let css = "";
  const usesTailwind =
    TAILWIND_SCRIPT.test(page) ||
    /type\s*=\s*["']text\/tailwindcss["']/i.test(page);
  if (usesTailwind) {
    const candidates = new Set<string>();
    for (const match of page.matchAll(CLASS))
      for (const name of match[2]!.split(/\s+/)) if (name) candidates.add(name);
    const extra = [
      themeFromPage(page),
      ...[...page.matchAll(TAILWIND_STYLE)].map((match) => match[1]!),
    ].join("\n");
    try {
      css = await kit.compileTailwind([...candidates], extra);
    } catch {
      // A theme it can't read: Tailwind's defaults, then.
      css = await kit.compileTailwind([...candidates]).catch(() => "");
    }
    page = page.replace(TAILWIND_STYLE, "");
  }
  const scripts = [
    ...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
  ].filter(
    ([, attrs, body]) =>
      !/cdn\.tailwindcss\.com|@tailwindcss\/browser|lucide/i.test(attrs!) &&
      !/^\s*(tailwind\.config\s*=|lucide\.createIcons\(\)\s*;?\s*$)/.test(
        body!,
      ) &&
      (body!.trim() || /\bsrc\s*=/.test(attrs!)),
  );
  if (scripts.length) limits.push("scripts");
  if (/<img\b[^>]*\bsrc\s*=\s*["']https?:/i.test(page)) limits.push("images");
  return { html: page, css, limits };
}
