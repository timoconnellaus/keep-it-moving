import "./viewer.css";
import { describeError } from "./errors.js";
import { errorHtml } from "./errorView.js";
import type { DesignLink, Prepare, Prepared } from "./render/types.js";
import {
  DESIGN_TYPES,
  noChanges,
  type ChangeCounts,
  type DesignShell,
  type DesignType,
} from "./types.js";

/**
 * The design viewer: runs inside an interview's sandboxed frame, reads the
 * design from the shell page's JSON, draws it, and talks to the parent with
 * postMessage. Each renderer loads on demand, so a data model never
 * downloads Mermaid or D2.
 */

declare global {
  interface Window {
    kimDesignSvg?: () => string;
  }
}

const LOADERS: Record<DesignType, () => Promise<Prepare>> = {
  "data-model": () => import("./render/dataModel.js").then((m) => m.prepare),
  api: () => import("./render/api.js").then((m) => m.prepare),
  architecture: () => import("./render/d2.js").then((m) => m.prepare),
  "data-flow": () => import("./render/d2.js").then((m) => m.prepare),
  sequence: () =>
    import("./render/mermaid.js").then((m) => m.prepareMermaid("sequence")),
  state: () =>
    import("./render/mermaid.js").then((m) => m.prepareMermaid("state")),
};

const NOUN: Record<DesignType, string> = {
  "data-model": "data model",
  architecture: "architecture diagram",
  "data-flow": "data flow diagram",
  sequence: "sequence diagram",
  state: "state diagram",
  api: "API contract",
};

function readShell(): DesignShell {
  const el = document.getElementById("kim-design");
  if (!el?.textContent) throw new Error("This page has no design in it.");
  const data = JSON.parse(el.textContent) as Partial<DesignShell>;
  if (!data.type || !(DESIGN_TYPES as readonly string[]).includes(data.type))
    throw new Error(`Unknown design type: ${String(data.type)}`);
  return {
    type: data.type,
    title: typeof data.title === "string" ? data.title : "",
    source: typeof data.source === "string" ? data.source : "",
    base: typeof data.base === "string" ? data.base : null,
  };
}

function report(counts: ChangeCounts) {
  if (window.parent !== window)
    window.parent.postMessage({ type: "kim-design-changes", ...counts }, "*");
}

function legend(counts: ChangeCounts): string {
  const item = (cls: string, n: number, label: string) =>
    `<span class="item"><i class="${cls}"></i>${n} ${label}</span>`;
  return `<div class="kim-legend" data-name="compare legend">${item("added", counts.added, "added")}${item(
    "changed",
    counts.changed,
    "changed",
  )}${item("removed", counts.removed, "removed")}</div>`;
}

/** Zoom limits, and how far a ctrl-scroll or a button steps. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const STEP = 1.25;

/**
 * Fits an SVG design to the frame and lets the reader zoom (ctrl or ⌘ and
 * scroll, a pinch, or the buttons) and pan (drag, or scroll). It sizes the
 * SVG itself rather than transforming it, so the page scrolls as usual and
 * comment pins, which follow their elements' boxes, stay on them.
 */
class Zoom {
  private svg: SVGSVGElement | null = null;
  private natural = { w: 0, h: 0 };
  private zoom = 1;
  /** Set once the reader zooms; until then the design refits as the frame resizes. */
  private chosen = false;
  private readonly bar: HTMLElement;
  private readonly level: HTMLButtonElement;

  constructor() {
    this.bar = document.createElement("div");
    this.bar.className = "kim-zoom";
    this.bar.setAttribute("data-name", "zoom controls");
    const button = (label: string, title: string, act: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", act);
      this.bar.appendChild(b);
      return b;
    };
    button("−", "Zoom out", () => this.step(1 / STEP));
    this.level = button("100%", "Actual size", () => this.set(1));
    button("+", "Zoom in", () => this.step(STEP));
    button("Fit", "Fit to the frame", () => this.fit());
    window.addEventListener(
      "wheel",
      (event) => {
        if (!this.svg || !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        this.set(this.zoom * Math.exp(-event.deltaY * 0.01), event);
      },
      { passive: false },
    );
    window.addEventListener("resize", () => {
      if (this.svg && !this.chosen) this.fit();
    });
  }

  /** Takes over a freshly drawn canvas; designs that aren't SVG aren't zoomed. */
  attach(canvas: HTMLElement) {
    const svg = canvas.querySelector<SVGSVGElement>(":scope > svg");
    this.svg = svg;
    if (!svg) {
      this.bar.remove();
      return;
    }
    const box = svg.getBoundingClientRect();
    this.natural = { w: box.width, h: box.height };
    if (!svg.getAttribute("viewBox") && box.width && box.height)
      svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    document.body.appendChild(this.bar);
    if (this.chosen) this.apply();
    else this.fit();
  }

  fit() {
    if (!this.svg || !this.natural.w || !this.natural.h) return;
    const top = this.svg.getBoundingClientRect().top + window.scrollY;
    const room = {
      w: document.documentElement.clientWidth - 32,
      h: window.innerHeight - top - 16,
    };
    this.chosen = false;
    this.zoom = Math.max(
      MIN_ZOOM,
      Math.min(1, room.w / this.natural.w, room.h / this.natural.h),
    );
    this.apply();
    window.scrollTo(0, 0);
  }

  private step(factor: number) {
    // From the buttons: around the middle of what's in view.
    this.set(this.zoom * factor, {
      clientX: window.innerWidth / 2,
      clientY: window.innerHeight / 2,
    });
  }

  /** Zooms to `zoom`, keeping the point under `at` where it is. */
  private set(zoom: number, at?: { clientX: number; clientY: number }) {
    if (!this.svg) return;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    const before = this.svg.getBoundingClientRect();
    const point = at ?? { clientX: before.left, clientY: before.top };
    const fx = before.width ? (point.clientX - before.left) / before.width : 0;
    const fy = before.height ? (point.clientY - before.top) / before.height : 0;
    this.chosen = true;
    this.zoom = next;
    this.apply();
    const after = this.svg.getBoundingClientRect();
    window.scrollBy(
      after.left + fx * after.width - point.clientX,
      after.top + fy * after.height - point.clientY,
    );
  }

  private apply() {
    if (!this.svg) return;
    // Mermaid caps its SVG with an inline max-width.
    this.svg.style.maxWidth = "none";
    this.svg.style.width = `${this.natural.w * this.zoom}px`;
    this.svg.style.height = `${this.natural.h * this.zoom}px`;
    this.level.textContent = `${Math.round(this.zoom * 100)}%`;
    // The comments script redraws pins on scroll; sizing alone doesn't scroll.
    window.dispatchEvent(new Event("scroll"));
  }
}

/**
 * Following a part's connections: clicking a part lights it, what it
 * connects to and the connections between; clicking a connection lights
 * it and its two ends. Everything else fades until a click elsewhere or Esc.
 */
class Focus {
  private links: DesignLink[] = [];
  private current: string | null = null;

  setLinks(links: DesignLink[]) {
    this.links = links;
  }

  /** The nearest named part a click landed in that something connects. */
  private partAt(target: Element | null): string | null {
    for (
      let el = target?.closest("[data-name]");
      el;
      el = el.parentElement?.closest("[data-name]")
    ) {
      const name = el.getAttribute("data-name")!;
      if (this.links.some((l) => [l.edge, l.from, l.to].includes(name)))
        return name;
    }
    return null;
  }

  click(target: Element | null) {
    const name = this.partAt(target);
    this.current = name === this.current ? null : name;
    this.apply();
  }

  clear() {
    this.current = null;
    this.apply();
  }

  /** Lights the current part again, as after a redraw. */
  apply() {
    for (const el of document.querySelectorAll(".kim-lit"))
      el.classList.remove("kim-lit");
    const name = this.current;
    if (!name) {
      delete document.documentElement.dataset.kimFocus;
      return;
    }
    const lit = new Set([name]);
    for (const l of this.links)
      if (l.edge === name || l.from === name || l.to === name) {
        lit.add(l.edge);
        lit.add(l.from);
        lit.add(l.to);
      }
    for (const part of lit)
      for (const el of document.querySelectorAll(
        `[data-name="${CSS.escape(part)}"]`,
      ))
        el.classList.add("kim-lit");
    document.documentElement.dataset.kimFocus = name;
  }
}

/** Dragging pans the page; a press that doesn't move is a click. */
function pan(onClick: (target: Element | null) => void) {
  let start: { x: number; y: number; target: Element | null } | null = null;
  let moved = false;
  window.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest(".kim-zoom, .kim-legend, button, a")) return;
    start = { x: event.clientX, y: event.clientY, target };
    moved = false;
  });
  window.addEventListener("pointermove", (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    document.documentElement.dataset.kimPanning = "";
    window.scrollBy(-dx, -dy);
    start = { ...start, x: event.clientX, y: event.clientY };
  });
  const end = () => {
    if (start && !moved) onClick(start.target);
    start = null;
    delete document.documentElement.dataset.kimPanning;
  };
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", () => {
    start = null;
    delete document.documentElement.dataset.kimPanning;
  });
}

async function main() {
  const root =
    document.getElementById("kim-design-root") ??
    document.body.appendChild(document.createElement("main"));
  let shell: DesignShell;
  try {
    shell = readShell();
  } catch (error) {
    root.innerHTML = errorHtml("design", "", describeError(error));
    document.documentElement.dataset.kimRendered = "error";
    window.kimDesignSvg = () => "";
    report(noChanges());
    return;
  }
  if (shell.title) document.title = shell.title;
  document.documentElement.dataset.kimType = shell.type;
  let prepared: Prepared;
  try {
    const prepare = await LOADERS[shell.type]();
    prepared = await Promise.race([
      prepare(shell.source, shell.base),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Drawing this design took too long.")),
          60_000,
        ),
      ),
    ]);
  } catch (error) {
    console.error(error);
    root.innerHTML = errorHtml(
      NOUN[shell.type],
      shell.source,
      describeError(error),
    );
    document
      .getElementById("kim-bad-line")
      ?.scrollIntoView({ block: "center" });
    document.documentElement.dataset.kimRendered = "error";
    window.kimDesignSvg = () => "";
    report(noChanges());
    return;
  }
  let compare = true;
  const zoom = new Zoom();
  const focus = new Focus();
  focus.setLinks(prepared.links);
  pan((target) => focus.click(target));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") focus.clear();
  });
  const draw = () => {
    const showing = compare && prepared.comparable;
    const canvas = document.createElement("div");
    canvas.className = "kim-canvas";
    try {
      prepared.draw(canvas, showing);
    } catch (error) {
      console.error(error);
      root.innerHTML = errorHtml(
        NOUN[shell.type],
        shell.source,
        describeError(error),
      );
      document.documentElement.dataset.kimRendered = "error";
      return;
    }
    root.replaceChildren(canvas);
    if (showing) root.insertAdjacentHTML("afterbegin", legend(prepared.counts));
    zoom.attach(canvas);
    focus.apply();
    document.documentElement.dataset.kimCompare = showing ? "on" : "off";
    report(prepared.counts);
  };
  window.kimDesignSvg = () => prepared.exportSvg();
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) return;
    const message = data as { type?: unknown; on?: unknown };
    if (
      message.type === "kim-compare" &&
      typeof message.on === "boolean" &&
      message.on !== compare
    ) {
      compare = message.on;
      draw();
    }
  });
  draw();
  document.documentElement.dataset.kimRendered ??= "ok";
}

void main();
