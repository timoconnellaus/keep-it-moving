import {
  operationName,
  type ApiDiff,
  type ApiModel,
  type SectionDiff,
} from "./api.js";
import { attr, esc, estimateWidth, type Measure } from "./svg.js";
import { COLORS, type Status } from "./types.js";

/** The API contract drawn as endpoint cards: HTML for the frame, SVG for export. */

const TAG: Record<Exclude<Status, "same">, string> = {
  added: "new",
  changed: "changed",
  removed: "removed",
};
const LINE_CLASS: Record<Status, string> = {
  same: "",
  added: "a",
  changed: "c",
  removed: "d",
};

/** `compare` marks lines; off for whole new or removed operations, whose card says it all. */
function sectionHtml(section: SectionDiff, compare: boolean): string {
  const st = compare ? section.status : "same";
  const lines = section.lines
    .map((l) => {
      const ls =
        compare && section.status !== "added" && section.status !== "removed"
          ? l.status
          : "same";
      const cls = LINE_CLASS[ls];
      const text = esc(l.item) || " ";
      const title =
        ls === "changed" && l.before !== undefined
          ? ` title="was: ${attr(l.before.trim())}"`
          : "";
      return cls
        ? `<span class="ln ${cls}"${title}>${text}</span>`
        : `<span class="ln">${text}</span>`;
    })
    .join("\n");
  const titleClass =
    st === "added" || st === "removed" ? ` class="${LINE_CLASS[st]}"` : "";
  return `<h6${titleClass}>${esc(section.title)}</h6><pre>${lines}</pre>`;
}

export function apiHtml(
  model: ApiModel,
  diff: ApiDiff,
  compare: boolean,
): string {
  const head =
    model.title || model.version
      ? `<header class="api-head">${model.title ? `<h1>${esc(model.title)}</h1>` : ""}${
          model.version
            ? `<span class="pill">v${esc(model.version)}</span>`
            : ""
        }<span class="pill">${model.operations.length} operation${model.operations.length === 1 ? "" : "s"}</span></header>`
      : "";
  if (diff.operations.length === 0)
    return `<div class="kim-api">${head}<p class="empty">No operations under <code>paths</code> yet.</p></div>`;
  const cards = diff.operations.map((o) => {
    const op = o.operation;
    const st = compare ? o.status : "same";
    const [request, ...responses] = o.sections;
    const summaryChanged =
      compare && o.before && o.before.summary !== op.summary;
    return [
      `<article class="ep${st === "same" ? "" : ` ${st}`}${op.deprecated ? " deprecated" : ""}" data-name="${attr(operationName(op))}">`,
      `<div class="head"><span class="m m-${esc(op.method)}">${esc(op.method)}</span>`,
      `<span class="path">${esc(op.path)}</span>`,
      st !== "same" ? `<span class="tag ${st}">${TAG[st]}</span>` : "",
      op.deprecated ? `<span class="tag old">deprecated</span>` : "",
      op.summary
        ? `<span class="desc${summaryChanged ? " c" : ""}"${summaryChanged ? ` title="was: ${attr(o.before!.summary)}"` : ""}>${esc(op.summary)}</span>`
        : "",
      `</div><div class="cols"><div>`,
      request ? sectionHtml(request, compare && o.status === "changed") : "",
      `</div><div>`,
      responses.length
        ? responses
            .map((s) => sectionHtml(s, compare && o.status === "changed"))
            .join("")
        : `<h6>Responses</h6><pre>—</pre>`,
      `</div></div></article>`,
    ].join("");
  });
  return `<div class="kim-api">${head}${cards.join("")}</div>`;
}

const METHOD_COLORS: Record<string, string> = {
  GET: COLORS.blue,
  POST: COLORS.green,
  PUT: "#7a5af5",
  PATCH: COLORS.amber,
  DELETE: COLORS.red,
};
export const methodColor = (method: string) =>
  METHOD_COLORS[method] ?? COLORS.muted;

const SVG_WIDTH = 1000;
const LINE = 18;
const MONO = "400 11.5px 'JetBrains Mono', ui-monospace, Menlo, monospace";

function fit(text: string, room: number, measure: Measure): string {
  if (measure(text, MONO) <= room) return text;
  let t = text;
  while (t.length > 1 && measure(`${t}…`, MONO) > room) t = t.slice(0, -1);
  return `${t}…`;
}

/** Plain endpoint cards as a standalone SVG, for previews (no highlights). */
export function apiSvg(
  model: ApiModel,
  measure: Measure = estimateWidth,
): string {
  const parts: string[] = [];
  let y = 20;
  const col = (SVG_WIDTH - 40) / 2;
  if (model.title) {
    parts.push(
      `<text x="20" y="${y + 18}" class="h1">${esc(model.title)}${model.version ? ` <tspan class="muted">v${esc(model.version)}</tspan>` : ""}</text>`,
    );
    y += 40;
  }
  for (const op of model.operations) {
    const [request, ...responses] = op.sections;
    const columnHeight = (sections: typeof op.sections) =>
      sections.reduce((h, s) => h + 22 + s.lines.length * LINE + 8, 0);
    const bodyHeight =
      Math.max(
        columnHeight(request ? [request] : []),
        columnHeight(responses),
        30,
      ) + 12;
    const height = 42 + bodyHeight;
    const x = 20;
    const methodWidth = measure(op.method, "600 11px 'JetBrains Mono'") + 14;
    parts.push(
      `<g data-name="${attr(operationName(op))}" transform="translate(${x} ${y})">`,
      `<rect width="${SVG_WIDTH - 40}" height="${height}" rx="10" fill="#fff" stroke="${COLORS.lineStrong}"/>`,
      `<line x1="0" y1="42" x2="${SVG_WIDTH - 40}" y2="42" stroke="${COLORS.line}"/>`,
      `<line x1="${col}" y1="42" x2="${col}" y2="${height}" stroke="${COLORS.line}"/>`,
      `<rect x="12" y="12" width="${methodWidth}" height="18" rx="5" fill="${methodColor(op.method)}"/>`,
      `<text x="${12 + methodWidth / 2}" y="25" text-anchor="middle" class="m">${esc(op.method)}</text>`,
      `<text x="${methodWidth + 22}" y="26" class="path">${esc(op.path)}</text>`,
    );
    if (op.summary) {
      const px =
        methodWidth + 22 + measure(op.path, "500 12.5px 'JetBrains Mono'") + 12;
      parts.push(
        `<text x="${px}" y="26" class="desc">${esc(fit(op.summary, SVG_WIDTH - 60 - px, measure))}</text>`,
      );
    }
    const column = (sections: typeof op.sections, cx: number) => {
      let cy = 42 + 12;
      for (const s of sections) {
        parts.push(
          `<text x="${cx}" y="${cy + 10}" class="h6">${esc(s.title.toUpperCase())}</text>`,
        );
        cy += 22;
        for (const line of s.lines) {
          parts.push(
            `<text x="${cx}" y="${cy + 12}" class="code" xml:space="preserve">${esc(fit(line, col - 28, measure))}</text>`,
          );
          cy += LINE;
        }
        cy += 8;
      }
    };
    column(request ? [request] : [], 14);
    column(responses, col + 14);
    parts.push(`</g>`);
    y += height + 14;
  }
  if (model.operations.length === 0) {
    parts.push(`<text x="20" y="${y + 16}" class="desc">No operations</text>`);
    y += 30;
  }
  const height = y + 6;
  const style = `text{font-family:Figtree,system-ui,sans-serif;fill:${COLORS.ink}}
.h1{font:600 18px Outfit,Figtree,sans-serif}.muted{fill:${COLORS.muted};font-size:13px}
.m{font:600 11px 'JetBrains Mono',ui-monospace,monospace;fill:#fff}
.path{font:500 12.5px 'JetBrains Mono',ui-monospace,monospace}
.desc{font-size:13px;fill:${COLORS.muted}}
.h6{font:600 10.5px Figtree,sans-serif;letter-spacing:.05em;fill:${COLORS.faint}}
.code{font:${MONO};white-space:pre}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${height}" viewBox="0 0 ${SVG_WIDTH} ${height}">` +
    `<style>${style}</style><rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>`
  );
}
