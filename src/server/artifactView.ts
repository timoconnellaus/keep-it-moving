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

/**
 * Comments and keys inside a served artifact: a function source, run as
 * `(source)(window)`. Asked `{ type: "kim-pick", req, x, y }` by the page
 * framing it, it finds the element at that point of the viewport (its
 * `data-name`, else a short description and a selector that finds it
 * again), outlines it for a moment and answers `kim-picked`. Sent
 * `{ type: "kim-pins", pins }`, it draws each pin on its element, so pins
 * follow the element as the page scrolls or reflows. Esc goes up to the
 * framing page as `kim-key`, so it backs out even when the frame has
 * focus. Its marks live in one layer over the page and change nothing in
 * it.
 */
export const COMMENTS_SOURCE = `(function (window) {
  var document = window.document;
  var PINK = "#f2357b";
  var BLOCK = "button, a, input, select, textarea, label, summary, h1, h2, h3, h4, h5, h6, p, li, td, th, img, svg, figure, figcaption, blockquote";
  var TEXTUAL = /^(button|a|label|summary|h[1-6]|p|li|td|th|figcaption|blockquote)$/;
  var layer = null;
  var pins = [];
  function squash(text) {
    return String(text || "").replace(/\\s+/g, " ").trim();
  }
  function clip(text, max) {
    return text.length > max ? text.slice(0, max - 1) + "\\u2026" : text;
  }
  function quoteAttribute(value) {
    return '"' + String(value).replace(/["\\\\]/g, "\\\\$&") + '"';
  }
  // What a person would call the element: its label or text, else its id or class.
  function describe(el) {
    var tag = el.tagName.toLowerCase();
    var label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("placeholder") || el.getAttribute("title");
    if (!label && el.labels && el.labels.length) label = el.labels[0].textContent;
    if (!label && TEXTUAL.test(tag)) label = el.textContent;
    label = squash(label);
    if (label) return tag + ' "' + clip(label, 40) + '"';
    if (el.id) return tag + "#" + el.id;
    var name = typeof el.className === "string" ? el.className.trim().split(/\\s+/)[0] : "";
    return name ? tag + "." + name : tag;
  }
  // A path from the nearest unique id, or from the body.
  function selectorFor(el) {
    var parts = [];
    for (var node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id) && document.querySelectorAll("#" + node.id).length === 1) {
        parts.unshift("#" + node.id);
        return parts.join(" > ");
      }
      var index = 1;
      for (var sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling)
        if (sibling.tagName === node.tagName) index++;
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + index + ")");
    }
    return parts.length ? "body > " + parts.join(" > ") : "body";
  }
  function elementAt(x, y) {
    var el = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
    if (!el || el === document.documentElement || el === document.body) return { el: document.body, element: "page", selector: "body" };
    var named = el.closest("[data-name]");
    if (named) return { el: named, element: named.getAttribute("data-name"), selector: null };
    var block = el.closest(BLOCK) || el;
    return { el: block, element: describe(block), selector: selectorFor(block) };
  }
  function find(pin) {
    try {
      return pin.selector ? document.querySelector(pin.selector) : document.querySelector("[data-name=" + quoteAttribute(pin.element) + "]");
    } catch (error) {
      return null;
    }
  }
  function overlay() {
    if (!layer || !layer.isConnected) {
      layer = document.createElement("div");
      layer.setAttribute("aria-hidden", "true");
      layer.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none";
      document.documentElement.appendChild(layer);
    }
    return layer;
  }
  function draw() {
    var host = overlay();
    host.replaceChildren();
    pins.forEach(function (pin) {
      var el = find(pin);
      var x = pin.x;
      var y = pin.y;
      if (el) {
        var r = el.getBoundingClientRect();
        x = r.left + window.scrollX + pin.fx * r.width;
        y = r.top + window.scrollY + pin.fy * r.height;
      }
      var mark = document.createElement("span");
      mark.textContent = String(pin.n);
      mark.style.cssText = "position:absolute;left:" + x + "px;top:" + y + "px;transform:translateY(-100%);display:grid;place-items:center;width:26px;height:26px;border-radius:50% 50% 50% 0;background:" + PINK + ";color:#fff;font:700 12px/1 system-ui,sans-serif;box-shadow:0 0 0 2px #fff,0 6px 14px -4px rgb(14 15 17 / .4)";
      host.appendChild(mark);
    });
  }
  function flash(rect) {
    var box = document.createElement("div");
    box.style.cssText = "position:absolute;left:" + (rect.left + window.scrollX - 4) + "px;top:" + (rect.top + window.scrollY - 4) + "px;width:" + (rect.width + 8) + "px;height:" + (rect.height + 8) + "px;border:3px solid " + PINK + ";border-radius:6px;box-sizing:border-box";
    overlay().appendChild(box);
    setTimeout(function () {
      box.remove();
    }, 900);
  }
  function pick(data) {
    var found = elementAt(data.x, data.y);
    var r = found.el.getBoundingClientRect();
    if (found.el !== document.body) flash(r);
    var within = function (value) {
      return Math.min(1, Math.max(0, value));
    };
    window.parent.postMessage({
      type: "kim-picked",
      req: data.req,
      element: found.element,
      selector: found.selector,
      fx: r.width ? within((data.x - r.left) / r.width) : 0,
      fy: r.height ? within((data.y - r.top) / r.height) : 0,
      x: data.x + window.scrollX,
      y: data.y + window.scrollY,
      width: document.documentElement.clientWidth || window.innerWidth
    }, "*");
  }
  var queued = false;
  function redraw() {
    if (queued || !pins.length) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(function () {
      queued = false;
      draw();
    });
  }
  window.addEventListener("scroll", redraw, { passive: true });
  window.addEventListener("resize", redraw);
  window.addEventListener("load", redraw);
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data) return;
    if (data.type === "kim-pick") pick(data);
    if (data.type === "kim-pins" && Array.isArray(data.pins)) {
      pins = data.pins;
      draw();
    }
  });
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") window.parent.postMessage({ type: "kim-key", key: "Escape" }, "*");
  }, true);
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
 * reload, the agent's view and later questions show what was decided, the
 * applier script that follows live previews, and the comments script. Text slots holding only
 * text are filled here; the script sets variables and attributes from
 * the head, before anything paints.
 */
/**
 * For a page framed from memory (`srcdoc`), which has no URL of its own:
 * no referrer on what it loads, since the frame would otherwise send the
 * interview's page URL, and the query an archify diagram reads its theme
 * and embed mode from.
 */
const inlineSetup = (query: string) =>
  `<meta name="referrer" content="no-referrer"><script>(function (query) {
  var Native = window.URLSearchParams;
  function Params(init) {
    return new Native(init === undefined || init === window.location.search ? query : init);
  }
  Params.prototype = Native.prototype;
  window.URLSearchParams = Params;
})(${JSON.stringify(query)});</script>`;

export function renderArtifact(
  html: string,
  values: ControlValues,
  /** Framed with srcdoc: the query string the page would have had. */
  inline?: { query: string },
): string {
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
  const script = `${inline ? inlineSetup(inline.query) : ""}<script>${APPLIER_SOURCE}(window, ${state});${COMMENTS_SOURCE}(window);</script>`;
  // In the head, but after a doctype: anything before one means quirks mode.
  const anchor =
    /<head\b[^>]*>/i.exec(content) ??
    /<html\b[^>]*>/i.exec(content) ??
    /^\s*<!doctype[^>]*>/i.exec(content);
  const at = anchor ? anchor.index + anchor[0].length : 0;
  return content.slice(0, at) + script + content.slice(at);
}
