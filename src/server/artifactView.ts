import { controlKind, type ControlValues } from "../shared/bindings.js";

/**
 * Serves an html artifact as its own sandbox, even if opened directly:
 * scripts run with an opaque origin that can't read or write the API, and
 * requests it makes carry no referrer (which would include the session token).
 * Only this site's pages may frame it.
 */
export const ARTIFACT_VIEW_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
};

/**
 * Whether a request would show the artifact as a whole page, which would
 * let anyone's HTML pose as this site (a fake sign-in, say) at a link they
 * send. The page only ever frames it. A browser that sends no
 * Sec-Fetch-Dest gets it, still sandboxed.
 */
export const opensAsPage = (request: Request) =>
  request.headers.get("sec-fetch-dest") === "document";

/**
 * Applies control values inside a served artifact: a function source, run
 * as `(source)(window, initial)`. It applies the saved values at once,
 * from the head, so they show before first paint, then follows
 * `{ type: "kim-set", values }` messages from the page framing it. Each
 * message is the whole state: a control it leaves out goes back to what
 * the artifact had. Setting a font variable loads that family from Google
 * Fonts unless it is a generic or system font. Plain JavaScript in a
 * string, since bundlers rewrite a function's own source.
 */
export const APPLIER_SOURCE = `(function (window, initial) {
  var document = window.document;
  var root = document.documentElement;
  var CONTROL = /^(--[A-Za-z_][\\w-]*|@[a-z][a-z0-9-]*|#[\\w-]+)$/;
  var SYSTEM_FONT = /^(serif|sans-serif|monospace|cursive|fantasy|math|emoji|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|inherit|initial|unset|revert|arial|helvetica|helvetica neue|georgia|times|times new roman|courier|courier new|verdana|tahoma|trebuchet ms|segoe ui|sf pro.*|menlo|monaco|consolas)$/i;
  var originals = {};
  var current = {};
  var fonts = {};
  Object.keys(initial.originals || {}).forEach(function (control) {
    originals[control] = initial.originals[control];
  });
  function slots(control) {
    return document.querySelectorAll('[data-kim-text="' + control.slice(1) + '"]');
  }
  function read(control) {
    if (control.slice(0, 2) === "--") return root.style.getPropertyValue(control) || null;
    if (control[0] === "@") return root.getAttribute("data-kim-" + control.slice(1));
    var found = slots(control);
    return found.length ? found[0].textContent : undefined;
  }
  function loadFont(value) {
    var family = String(value).split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (!family || SYSTEM_FONT.test(family) || /[()]/.test(family) || fonts[family]) return;
    fonts[family] = true;
    var query = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(family).replace(/%20/g, "+");
    var link = document.createElement("link");
    link.rel = "stylesheet";
    // Not every family has these weights; Google refuses the request then.
    link.onerror = function () {
      link.onerror = null;
      link.href = query + "&display=swap";
    };
    link.href = query + ":wght@400;500;600;700&display=swap";
    (document.head || root).appendChild(link);
  }
  function write(control, value) {
    if (control.slice(0, 2) === "--") {
      if (value === null) root.style.removeProperty(control);
      else {
        root.style.setProperty(control, value);
        if (/font|family|typeface/i.test(control)) loadFont(value);
      }
    } else if (control[0] === "@") {
      if (value === null) root.removeAttribute("data-kim-" + control.slice(1));
      else root.setAttribute("data-kim-" + control.slice(1), value);
    } else if (value !== null) {
      slots(control).forEach(function (slot) {
        slot.textContent = value;
      });
    }
  }
  function apply(values) {
    Object.keys(current).forEach(function (control) {
      if (!(control in values)) write(control, control in originals ? originals[control] : null);
    });
    var next = {};
    Object.keys(values).forEach(function (control) {
      var value = values[control];
      if (!CONTROL.test(control) || typeof value !== "string") return;
      if (!(control in originals)) {
        var original = read(control);
        if (original !== undefined) originals[control] = original;
      }
      write(control, value);
      next[control] = value;
    });
    current = next;
  }
  apply(initial.values || {});
  // Text slots the server couldn't fill exist once the document has parsed.
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", function () {
      apply(current);
    });
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data || data.type !== "kim-set") return;
    if (data.values && typeof data.values === "object") apply(data.values);
  });
})`;

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeHtml = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * An html artifact as served: saved answers' values written in, so a
 * reload, the agent's view and later questions show what was decided, and
 * the applier script that follows live previews. Text slots holding only
 * text are filled here; the script sets variables and attributes from
 * the head, before anything paints.
 */
export function renderArtifact(html: string, values: ControlValues): string {
  const originals: ControlValues = {};
  let content = html;
  for (const [control, value] of Object.entries(values)) {
    if (controlKind(control) !== "text") continue;
    const name = control.slice(1).replace(/[-]/g, "\\-");
    const slot = new RegExp(
      `(<([a-zA-Z][\\w-]*)\\b[^>]*\\bdata-kim-text\\s*=\\s*(["']?)${name}\\3(?![\\w-])[^>]*>)([^<]*)(</\\2\\s*>)`,
      "g",
    );
    content = content.replace(
      slot,
      (_match, open: string, _tag, _quote, text: string, close: string) => {
        originals[control] ??= unescapeHtml(text);
        return `${open}${escapeHtml(value)}${close}`;
      },
    );
  }
  const state = JSON.stringify({ values, originals }).replace(/</g, "\\u003c");
  const script = `<script>${APPLIER_SOURCE}(window, ${state});</script>`;
  // In the head, but after a doctype: anything before one means quirks mode.
  const anchor =
    /<head\b[^>]*>/i.exec(content) ??
    /<html\b[^>]*>/i.exec(content) ??
    /^\s*<!doctype[^>]*>/i.exec(content);
  const at = anchor ? anchor.index + anchor[0].length : 0;
  return content.slice(0, at) + script + content.slice(at);
}
