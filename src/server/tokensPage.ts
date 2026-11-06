/**
 * The design system's tokens (`.kim/design-system/tokens.css`): CSS custom
 * properties, drawn as a page of swatches, type and sizes, compared with
 * the repo copy. And the link that lets a mockup use them.
 */

/** One custom property, as declared. */
export interface Token {
  name: string;
  value: string;
}

export type TokenGroup = "colour" | "type" | "size" | "shadow" | "other";

/** The custom properties a stylesheet declares, in order; a later one wins. */
export function parseTokens(css: string): Token[] {
  const tokens = new Map<string, string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of text.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g))
    tokens.set(match[1]!, match[2]!.trim().replace(/\s+/g, " "));
  return [...tokens].map(([name, value]) => ({ name, value }));
}

const COLOUR =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.*\)|transparent|currentcolor|[a-z]+)$/i;
const SIZE = /^-?[\d.]+(px|rem|em|%|vh|vw|ch)?$/i;

export function groupOf(token: Token): TokenGroup {
  const name = token.name.toLowerCase();
  const value = token.value.trim();
  if (/font|family|typeface|leading|line-height|weight|tracking/.test(name))
    return "type";
  if (/shadow|elevation/.test(name)) return "shadow";
  if (/^var\(/.test(value))
    return /color|colour|bg|ink|fg/.test(name) ? "colour" : "other";
  if (
    COLOUR.test(value) &&
    !SIZE.test(value) &&
    !/^(none|auto|inherit|initial|normal|bold)$/i.test(value)
  )
    return "colour";
  if (SIZE.test(value) || /^calc\(/.test(value)) return "size";
  return "other";
}

/** What changed between the repo's tokens and these. */
export interface TokenChanges {
  added: Set<string>;
  changed: Map<string, string>;
  removed: Token[];
}

export function compareTokens(tokens: Token[], base: Token[]): TokenChanges {
  const before = new Map(base.map((token) => [token.name, token.value]));
  const now = new Set(tokens.map((token) => token.name));
  const changes: TokenChanges = {
    added: new Set(),
    changed: new Map(),
    removed: base.filter((token) => !now.has(token.name)),
  };
  for (const token of tokens) {
    const old = before.get(token.name);
    if (old === undefined) changes.added.add(token.name);
    else if (old !== token.value) changes.changed.set(token.name, old);
  }
  return changes;
}

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const label = (name: string) =>
  name
    .replace(/^--/, "")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (first) => first.toUpperCase());

const GROUPS: Array<[TokenGroup, string]> = [
  ["colour", "Colour"],
  ["type", "Type"],
  ["size", "Spacing and sizes"],
  ["shadow", "Shadows"],
  ["other", "Other"],
];

/**
 * The tokens as a page: each group's tokens drawn with what they set,
 * added ones outlined green, changed ones amber with their old value, and
 * removed ones struck through. Every token has a data-name, so a comment
 * pinned on it names it. The tokens apply to the page itself, so a font or
 * colour shows as it will look.
 */
export function tokensPage(
  title: string,
  css: string,
  baseCss: string | null,
): string {
  const tokens = parseTokens(css);
  const changes =
    baseCss === null ? null : compareTokens(tokens, parseTokens(baseCss));
  const state = (name: string) =>
    !changes
      ? ""
      : changes.added.has(name)
        ? " added"
        : changes.changed.has(name)
          ? " changed"
          : "";
  const sample = (token: Token, group: TokenGroup) => {
    const value = `var(${token.name})`;
    if (group === "colour")
      return `<i class="swatch" style="background:${value}"></i>`;
    if (group === "shadow")
      return `<i class="shadow" style="box-shadow:${value}"></i>`;
    if (group === "size")
      return `<i class="bar" style="width:min(${value}, 100%)"></i>`;
    if (/family|font(?!-size|-weight)/i.test(token.name))
      return `<span class="type" style="font-family:${value}">The quick brown fox</span>`;
    return "";
  };
  const card = (token: Token, group: TokenGroup, removed = false) => {
    const old = changes?.changed.get(token.name);
    return `<div class="token${removed ? " removed" : state(token.name)}" data-name="${escape(token.name)} token">${removed ? "" : sample(token, group)}<b>${escape(label(token.name))}</b><code>${escape(token.name)}</code><code class="value">${old !== undefined ? `<s>${escape(old)}</s> → ` : ""}${escape(token.value)}</code></div>`;
  };
  const sections = GROUPS.map(([group, heading]) => {
    const here = tokens.filter((token) => groupOf(token) === group);
    const gone = (changes?.removed ?? []).filter(
      (token) => groupOf(token) === group,
    );
    if (!here.length && !gone.length) return "";
    return `<section data-name="${heading} tokens"><h2>${heading}</h2><div class="grid ${group}">${here.map((token) => card(token, group)).join("")}${gone.map((token) => card(token, group, true)).join("")}</div></section>`;
  }).join("");
  const counts = changes
    ? `<p class="summary">${
        [
          [changes.added.size, "added"],
          [changes.changed.size, "changed"],
          [changes.removed.length, "removed"],
        ]
          .filter(([count]) => count)
          .map(([count, word]) => `${count} ${word}`)
          .join(" · ") || "Same as the repo"
      }</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>${css.replace(/<\//g, "<\\/")}</style>
<style>
body{margin:0;padding:28px 32px 48px;background:#fff;color:#0e0f11;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
h1{margin:0 0 4px;font-size:22px}h2{margin:28px 0 12px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#676c74}
.summary{margin:0;color:#676c74}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.grid.type,.grid.size{grid-template-columns:1fr}
.token{display:grid;gap:3px;padding:10px 12px;border:1px solid #e4e6ea;border-radius:10px}
.grid.type .token,.grid.size .token{grid-template-columns:minmax(0,1fr) 160px 200px;align-items:center}
.token b{font-weight:600}.token code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#676c74;overflow-wrap:anywhere}
.token .value s{color:#d64545}
.swatch{display:block;height:56px;margin:-10px -12px 6px;border-radius:9px 9px 0 0;border-bottom:1px solid #e4e6ea}
.shadow{display:block;height:44px;margin-bottom:8px;border-radius:8px;background:#fff}
.bar{display:block;height:10px;border-radius:5px;background:#1f6bff;grid-column:1/-1}
.type{font-size:20px;grid-column:1/-1}
.added{border-color:#2fbf71;box-shadow:0 0 0 3px #e3f7ec}
.changed{border-color:#d98a00;box-shadow:0 0 0 3px #fff1d6}
.removed{border-style:dashed;border-color:#d64545;opacity:.7}.removed b{text-decoration:line-through}
</style></head><body><h1 data-name="design system title">${escape(title)}</h1>${counts}${sections || "<p>No tokens yet: declare CSS custom properties, such as <code>:root { --accent: #1f6bff; }</code>.</p>"}</body></html>`;
}

/** A stylesheet link to the design system's tokens, as a mockup in .kim/ writes it. */
const TOKENS_LINK =
  /<link\b[^>]*\bhref\s*=\s*["']?[^"'>\s]*design-system\/tokens\.css["']?[^>]*>/gi;

/** Whether a page uses the design system's tokens. */
export const usesTokens = (html: string) => {
  TOKENS_LINK.lastIndex = 0;
  return TOKENS_LINK.test(html);
};

/**
 * A mockup with its link to the tokens replaced by the interview's current
 * tokens, so it renders self-contained, and a token changed in the
 * interview shows in every mockup that uses it.
 */
export function withTokens(html: string, css: string): string {
  const style = `<style data-kim-tokens>${css.replace(/<\//g, "<\\/")}</style>`;
  return html.replace(TOKENS_LINK, () => style);
}
