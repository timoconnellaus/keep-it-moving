import "./viewer.css";
import { describeError } from "./errors.js";
import { errorHtml } from "./errorView.js";
import type { Prepare, Prepared } from "./render/types.js";
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
