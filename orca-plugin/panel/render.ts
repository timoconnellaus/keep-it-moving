/**
 * Draws a mockup inside the panel without running any of it: scripts,
 * frames, forms' targets, event handlers and links are removed, and the
 * page is drawn in a shadow root at its frame's width, scaled to fit.
 * Its media queries become container queries on that frame, so a desktop
 * mockup keeps its desktop layout in a narrow panel.
 */
import type { MockupView } from "../src/protocol";

const REMOVED =
  "script, iframe, frame, frameset, object, embed, link, meta, base, noscript, template, portal";
const URL_ATTRIBUTES = [
  "href",
  "src",
  "action",
  "formaction",
  "xlink:href",
  "poster",
  "srcset",
  "background",
];

export interface Split {
  styles: string[];
  /** Attributes of <html> and <body>, merged: they go on the page's root. */
  rootAttributes: Record<string, string>;
  body: string;
}

/** The page's styles, root attributes and body, with nothing left that acts. */
export function sanitize(html: string): Split {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const styles = [...doc.querySelectorAll("style")].map((style) => {
    const text = style.textContent ?? "";
    style.remove();
    return text;
  });
  doc.querySelectorAll(REMOVED).forEach((element) => element.remove());
  for (const element of doc.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      else if (
        URL_ATTRIBUTES.includes(name) &&
        !safeUrl(name, value, element.tagName)
      )
        element.removeAttribute(attribute.name);
      else if (
        name === "style" &&
        /url\(\s*["']?\s*(javascript|https?):/i.test(value)
      )
        element.setAttribute("style", value.replace(/url\([^)]*\)/gi, "none"));
    }
    if (element.tagName === "IMG" && !element.getAttribute("src"))
      element.setAttribute(
        "src",
        placeholder(element.getAttribute("alt") ?? ""),
      );
    if (element.tagName === "A") element.removeAttribute("href");
  }
  const rootAttributes: Record<string, string> = {};
  for (const source of [doc.documentElement, doc.body])
    for (const attribute of [...source.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name === "class" || name === "style")
        rootAttributes[name] = [rootAttributes[name], attribute.value]
          .filter(Boolean)
          .join(name === "class" ? " " : ";");
      else if (!name.startsWith("on")) rootAttributes[name] = attribute.value;
    }
  return { styles, rootAttributes, body: doc.body.innerHTML };
}

/** Only embedded images: the panel can fetch nothing, and links go nowhere. */
function safeUrl(name: string, value: string, tag: string): boolean {
  if (
    name === "href" ||
    name === "action" ||
    name === "formaction" ||
    name === "xlink:href"
  )
    return value.startsWith("#") && tag !== "A";
  if (name === "srcset") return false;
  return /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);/i.test(value);
}

/** A neutral box with an image's alt text, for one that couldn't be embedded. */
export function placeholder(alt: string): string {
  const text = alt.replace(/[<>&"']/g, "").slice(0, 40);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="100%" height="100%" fill="#e5e7eb"/><text x="50%" y="50%" fill="#6b7280" font-family="system-ui,sans-serif" font-size="14" text-anchor="middle" dominant-baseline="middle">${text || "Image"}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * The page's CSS, fitted to the shadow root: `html`, `body` and `:root`
 * become the page's root, width media queries become container queries
 * on its frame, and `vh` becomes the frame's height. Document-wide rules
 * (`@property`, `@font-face`) come back separately: a shadow root ignores
 * them, so the panel registers them on the document.
 */
export function scopeCss(
  css: string,
  frameHeight: number,
): { css: string; global: string } {
  const global: string[] = [];
  let out = "";
  let at = 0;
  while (at < css.length) {
    const open = css.indexOf("{", at);
    if (open < 0) {
      out += css.slice(at);
      break;
    }
    // What precedes the brace since the last statement is its prelude.
    const boundary = Math.max(
      css.lastIndexOf(";", open),
      css.lastIndexOf("}", open),
      at - 1,
    );
    const lead = css.slice(at, boundary + 1);
    const prelude = css.slice(boundary + 1, open);
    const trimmed = prelude.trim();
    if (/^@(property|font-face)\b/i.test(trimmed)) {
      const close = matching(css, open);
      global.push(css.slice(boundary + 1, close + 1).trim());
      out += lead;
      at = close + 1;
      continue;
    }
    out += lead + rewritePrelude(prelude) + "{";
    at = open + 1;
  }
  out = out.replace(
    /(?<=[\s:(,])(-?\d*\.?\d+)(?:d|s|l)?vh\b/g,
    (_, value: string) => `${(Number(value) * frameHeight) / 100}px`,
  );
  return { css: out, global: global.join("\n") };
}

function rewritePrelude(prelude: string): string {
  const trimmed = prelude.trim();
  if (trimmed.startsWith("@media")) {
    const query = trimmed.slice(6).trim();
    if (
      /\b(width|height)\b/.test(query) &&
      !/prefers-|print|hover|pointer/.test(query)
    ) {
      const conditions = query.replace(/^(only\s+)?(screen|all)\s+and\s+/i, "");
      return prelude.replace(trimmed, `@container kim ${conditions}`);
    }
    return prelude;
  }
  if (trimmed.startsWith("@")) return prelude;
  return prelude.replace(
    /(^|[\s,>+~(])(:root|html|body)(?=$|[\s,.:#[>+~)])/g,
    "$1.kim-root",
  );
}

function matching(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index++) {
    if (css[index] === "{") depth++;
    else if (css[index] === "}" && --depth === 0) return index;
  }
  return css.length - 1;
}

const registered = new Set<string>();
/** Adds document-wide rules once each. */
function registerGlobal(rules: string) {
  if (!rules.trim()) return;
  const style = document.createElement("style");
  const fresh = rules
    .split(/\n(?=@)/)
    .filter((rule) => {
      const key = rule.replace(/\s+/g, " ").slice(0, 200);
      if (registered.has(key)) return false;
      registered.add(key);
      return true;
    })
    .join("\n");
  if (!fresh) return;
  style.textContent = fresh;
  document.head.append(style);
}

export interface Mounted {
  /** Applies control values, such as a hovered option's, over the saved ones. */
  apply(values: Record<string, string>): void;
}

/**
 * Draws `view` into `host`, `width` pixels wide and in proportion to its
 * frame (or `maxHeight`, if less), and returns a handle to restyle it.
 */
export function mountMockup(
  host: HTMLElement,
  view: MockupView,
  width: number,
  maxHeight?: number,
): Mounted {
  const frameWidth = view.frame.width;
  const frameHeight = view.frame.height ?? 800;
  const scale = width / frameWidth;
  const height = Math.min(frameHeight * scale, maxHeight ?? Infinity);
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const split = sanitize(view.html);
  const tailwind = scopeCss(view.css, frameHeight);
  const own = scopeCss(split.styles.join("\n"), frameHeight);
  registerGlobal(`${tailwind.global}\n${own.global}`);
  root.innerHTML = "";
  const base = document.createElement("style");
  base.textContent = `:host{display:block;width:${width}px;height:${height}px;overflow:hidden;contain:strict;border-radius:inherit}
.kim-frame{container:kim/inline-size;width:${frameWidth}px;height:${frameHeight}px;transform:scale(${scale});transform-origin:0 0;overflow:hidden;pointer-events:none;user-select:none}
.kim-root{min-height:100%;background:#fff;color:#111;font-family:ui-sans-serif,system-ui,sans-serif;font-size:16px;line-height:1.5}`;
  const styles = document.createElement("style");
  styles.textContent = `${tailwind.css}\n${own.css}`;
  const frame = document.createElement("div");
  frame.className = "kim-frame";
  const page = document.createElement("div");
  for (const [name, value] of Object.entries(split.rootAttributes))
    page.setAttribute(name, value);
  page.classList.add("kim-root");
  page.innerHTML = split.body;
  frame.append(page);
  root.append(base, styles, frame);

  const originals = new Map<string, string | null>();
  let current: Record<string, string> = {};
  const write = (control: string, value: string | null) => {
    if (control.startsWith("--")) {
      if (value === null) page.style.removeProperty(control);
      else page.style.setProperty(control, value);
    } else if (control.startsWith("@")) {
      const name = `data-kim-${control.slice(1)}`;
      if (value === null) page.removeAttribute(name);
      else page.setAttribute(name, value);
    } else if (value !== null)
      page
        .querySelectorAll(`[data-kim-text="${CSS.escape(control.slice(1))}"]`)
        .forEach((slot) => {
          slot.textContent = value;
        });
  };
  const read = (control: string): string | null =>
    control.startsWith("--")
      ? page.style.getPropertyValue(control) || null
      : control.startsWith("@")
        ? page.getAttribute(`data-kim-${control.slice(1)}`)
        : (page.querySelector(
            `[data-kim-text="${CSS.escape(control.slice(1))}"]`,
          )?.textContent ?? null);
  const apply = (values: Record<string, string>) => {
    for (const control of Object.keys(current))
      if (!(control in values)) write(control, originals.get(control) ?? null);
    for (const [control, value] of Object.entries(values)) {
      if (!/^(--[A-Za-z_][\w-]*|@[a-z][a-z0-9-]*|#[\w-]+)$/.test(control))
        continue;
      if (!originals.has(control)) originals.set(control, read(control));
      write(control, value);
    }
    current = { ...values };
  };
  apply(view.values);
  return { apply: (values) => apply({ ...view.values, ...values }) };
}
