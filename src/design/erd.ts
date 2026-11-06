import dagre from "@dagrejs/dagre";
import {
  fieldBadges,
  fieldChange,
  fieldName,
  relationKey,
  relationName,
  tableName,
  type DataModelDiff,
  type Field,
  type Relation,
  type TableDiff,
} from "./dataModel.js";
import { attr, esc, estimateWidth, type Measure } from "./svg.js";
import { COLORS, type Status } from "./types.js";

/** Lays out the entity cards and draws the whole diagram as one SVG. */

const HEADER = 34;
const NOTE = 20;
const ROW = 22;
const PAD_BOTTOM = 6;
const MIN_WIDTH = 170;
const MAX_ROW_WIDTH = 1232;
const GAP = 48;
const MARGIN = 24;

const FONT = {
  title: "600 13.5px Outfit, Figtree, system-ui, sans-serif",
  mono: "400 11.5px 'JetBrains Mono', ui-monospace, Menlo, monospace",
  small: "400 11px Figtree, system-ui, sans-serif",
  badge: "600 9.5px Figtree, system-ui, sans-serif",
  tag: "600 9.5px Figtree, system-ui, sans-serif",
} as const;

interface Card {
  diff: TableDiff;
  width: number;
  height: number;
  x: number;
  y: number;
  note: string | null;
}

const TAG: Record<Exclude<Status, "same">, string> = {
  added: "new",
  changed: "changed",
  removed: "removed",
};

function fieldRight(
  f: Field,
  before: Field | undefined,
  status: Status,
): string {
  if (status === "changed" && before && before.type !== f.type)
    return `${before.type} → ${f.type}`;
  return f.type;
}

function cardSize(diff: TableDiff, measure: Measure, compare: boolean) {
  const t = diff.table;
  let width = measure(t.name, FONT.title) + 28;
  if (t.kind === "enum") width += measure("enum", FONT.badge) + 10;
  if (compare && diff.status !== "same")
    width += measure(TAG[diff.status].toUpperCase(), FONT.tag) + 22;
  for (const { item, before, status } of diff.fields) {
    const badges = fieldBadges(item);
    const right =
      measure(fieldRight(item, before, compare ? status : "same"), FONT.mono) +
      badges.reduce((w, b) => w + measure(b.toUpperCase(), FONT.badge) + 14, 0);
    width = Math.max(width, measure(item.name, FONT.mono) + right + 44);
  }
  width = Math.ceil(Math.max(MIN_WIDTH, Math.min(width, 420)));
  const note = t.note ? t.note.split("\n")[0]!.trim() : null;
  const height =
    HEADER + (note ? NOTE : 0) + diff.fields.length * ROW + PAD_BOTTOM;
  return { width, height, note };
}

/** Connected groups of tables, so unrelated groups don't stack in one column. */
function components(cards: Card[], relations: Relation[]): Card[][] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k) ?? k;
    if (p === k) return k;
    const root = find(p);
    parent.set(k, root);
    return root;
  };
  const names = new Set(cards.map((c) => c.diff.table.name));
  for (const r of relations)
    if (names.has(r.from.table) && names.has(r.to.table))
      parent.set(find(r.from.table), find(r.to.table));
  const groups = new Map<string, Card[]>();
  for (const c of cards) {
    const root = find(c.diff.table.name);
    groups.set(root, [...(groups.get(root) ?? []), c]);
  }
  return [...groups.values()];
}

function layoutGroup(group: Card[], relations: Relation[]) {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({
    rankdir: "LR",
    nodesep: 36,
    ranksep: 96,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));
  const byName = new Map(group.map((c) => [c.diff.table.name, c]));
  for (const c of group)
    g.setNode(c.diff.table.name, { width: c.width, height: c.height });
  relations.forEach((r, i) => {
    if (
      !byName.has(r.from.table) ||
      !byName.has(r.to.table) ||
      r.from.table === r.to.table
    )
      return;
    // From the one side to the many side, so parents sit left of children.
    const [one, many] =
      r.from.cardinality === "n" ? [r.to, r.from] : [r.from, r.to];
    g.setEdge(one.table, many.table, {}, `r${i}`);
  });
  dagre.layout(g);
  let maxX = 0;
  let maxY = 0;
  for (const c of group) {
    const node = g.node(c.diff.table.name);
    c.x = node.x - c.width / 2;
    c.y = node.y - c.height / 2;
    maxX = Math.max(maxX, c.x + c.width);
    maxY = Math.max(maxY, c.y + c.height);
  }
  return { width: maxX, height: maxY };
}

/** Positions every card: each connected group laid out, then packed in rows. */
export function layoutCards(
  diff: DataModelDiff,
  measure: Measure,
  compare: boolean,
): {
  cards: Card[];
  width: number;
  height: number;
} {
  const cards: Card[] = diff.tables.map((d) => ({
    diff: d,
    x: 0,
    y: 0,
    ...cardSize(d, measure, compare),
  }));
  const relations = diff.relations.map((r) => r.item);
  const groups = components(cards, relations)
    .map((group) => ({ group, ...layoutGroup(group, relations) }))
    .sort((a, b) => b.group.length - a.group.length || b.height - a.height);
  let x = MARGIN;
  let y = MARGIN;
  let rowHeight = 0;
  let width = 0;
  for (const g of groups) {
    if (x > MARGIN && x + g.width > MARGIN + MAX_ROW_WIDTH) {
      x = MARGIN;
      y += rowHeight + GAP;
      rowHeight = 0;
    }
    for (const c of g.group) {
      c.x += x;
      c.y += y;
    }
    x += g.width + GAP;
    rowHeight = Math.max(rowHeight, g.height);
    width = Math.max(width, x - GAP);
  }
  return {
    cards,
    width: Math.ceil(width + MARGIN),
    height: Math.ceil(y + rowHeight + MARGIN),
  };
}

function rowY(card: Card, fieldNameText: string | undefined): number {
  const top = card.y + HEADER + (card.note ? NOTE : 0);
  if (fieldNameText === undefined) return card.y + HEADER / 2;
  const index = card.diff.fields.findIndex(
    (f) => f.item.name === fieldNameText,
  );
  return index < 0 ? card.y + HEADER / 2 : top + index * ROW + ROW / 2;
}

function relationPath(a: Card, ay: number, b: Card, by: number) {
  const acx = a.x + a.width / 2;
  const bcx = b.x + b.width / 2;
  const overlap = Math.abs(acx - bcx) < (a.width + b.width) / 2 || a === b;
  if (overlap) {
    // Same column: leave and enter on the right, looping out.
    const sx = a.x + a.width;
    const ex = b.x + b.width;
    const out = Math.max(sx, ex) + 36;
    return {
      d: `M${sx} ${ay} C${out} ${ay} ${out} ${by} ${ex} ${by}`,
      start: { x: sx + 8, y: ay, anchor: "start" },
      end: { x: ex + 8, y: by, anchor: "start" },
    };
  }
  const leftToRight = acx < bcx;
  const sx = leftToRight ? a.x + a.width : a.x;
  const ex = leftToRight ? b.x : b.x + b.width;
  const dx = Math.max(40, Math.abs(ex - sx) / 2) * (leftToRight ? 1 : -1);
  return {
    d: `M${sx} ${ay} C${sx + dx} ${ay} ${ex - dx} ${by} ${ex} ${by}`,
    start: {
      x: sx + (leftToRight ? 7 : -7),
      y: ay,
      anchor: leftToRight ? "start" : "end",
    },
    end: {
      x: ex + (leftToRight ? -7 : 7),
      y: by,
      anchor: leftToRight ? "end" : "start",
    },
  };
}

const STYLE = `
.kim-erd text{font-family:Figtree,system-ui,sans-serif}
.kim-erd .title{font:${FONT.title};fill:${COLORS.ink}}
.kim-erd .note{font:italic ${FONT.small};fill:${COLORS.muted}}
.kim-erd .fname{font:${FONT.mono};fill:${COLORS.ink}}
.kim-erd .fname.pk{font-weight:600}
.kim-erd .ftype{font:${FONT.mono};fill:${COLORS.faint}}
.kim-erd .badge{font:${FONT.badge};letter-spacing:.04em}
.kim-erd .card{fill:#fff;stroke:${COLORS.lineStrong};stroke-width:1}
.kim-erd .card.enum{fill:${COLORS.panel}}
.kim-erd .head-line{stroke:${COLORS.line}}
.kim-erd .rel{fill:none;stroke:${COLORS.faint};stroke-width:1.5}
.kim-erd .card-text{font:500 10px 'JetBrains Mono',ui-monospace,monospace;fill:${COLORS.muted}}
.kim-erd .card.added{stroke:${COLORS.green};stroke-width:1.5}
.kim-erd .head.added{fill:${COLORS.greenSoft}}
.kim-erd .card.changed{stroke:${COLORS.amber};stroke-width:1.5}
.kim-erd .card.removed{stroke:${COLORS.red};stroke-width:1.5;stroke-dasharray:6 4}
.kim-erd .head.removed{fill:${COLORS.redSoft}}
.kim-erd .row.added{fill:${COLORS.greenSoft}}
.kim-erd .row.changed{fill:${COLORS.amberSoft}}
.kim-erd .row.removed{fill:${COLORS.redSoft}}
.kim-erd .removed-text{fill:${COLORS.redInk};text-decoration:line-through}
.kim-erd .ftype.changed{fill:${COLORS.amberInk}}
.kim-erd .rel.added{stroke:${COLORS.green};stroke-width:2}
.kim-erd .rel.changed{stroke:${COLORS.amber};stroke-width:2}
.kim-erd .rel.removed{stroke:${COLORS.red};stroke-width:1.5;stroke-dasharray:5 4}
.kim-erd .tag{font:${FONT.tag};fill:#fff;text-transform:uppercase;letter-spacing:.04em}
`;

const statusClass = (status: Status, compare: boolean) =>
  compare && status !== "same" ? ` ${status}` : "";

function drawCard(card: Card, measure: Measure, compare: boolean): string {
  const { diff } = card;
  const t = diff.table;
  const st = compare ? diff.status : "same";
  const parts: string[] = [];
  const clipId = `clip-${esc(t.name).replace(/[^\w-]/g, "_")}`;
  parts.push(
    `<g class="table" data-name="${attr(tableName(t))}" transform="translate(${card.x} ${card.y})">`,
    `<title>${esc(t.name)}${t.note ? `\n${esc(t.note)}` : ""}</title>`,
    `<clipPath id="${attr(clipId)}"><rect width="${card.width}" height="${card.height}" rx="10"/></clipPath>`,
    `<rect class="card${t.kind === "enum" ? " enum" : ""}${statusClass(st, true)}" width="${card.width}" height="${card.height}" rx="10"/>`,
    `<g clip-path="url(#${attr(clipId)})">`,
  );
  if (st === "added" || st === "removed")
    parts.push(
      `<rect class="head ${st}" width="${card.width}" height="${HEADER}"/>`,
    );
  let y = HEADER;
  if (card.note) y += NOTE;
  diff.fields.forEach((f) => {
    const fs = compare ? f.status : "same";
    if (fs !== "same" && st === "changed")
      parts.push(
        `<rect class="row ${fs}" y="${y}" width="${card.width}" height="${ROW}"/>`,
      );
    y += ROW;
  });
  parts.push(`</g>`);
  parts.push(
    `<line class="head-line" x1="0" y1="${HEADER}" x2="${card.width}" y2="${HEADER}"/>`,
    `<text class="title${st === "removed" ? " removed-text" : ""}" x="12" y="${HEADER / 2 + 5}">${esc(t.name)}</text>`,
  );
  if (t.kind === "enum")
    parts.push(
      `<text class="card-text" x="${12 + measure(t.name, FONT.title) + 8}" y="${HEADER / 2 + 4}">enum</text>`,
    );
  if (st !== "same") {
    const label = TAG[st];
    const w = measure(label.toUpperCase(), FONT.tag) + 12;
    const x = card.width - w - 10;
    const fill =
      st === "added"
        ? COLORS.green
        : st === "changed"
          ? COLORS.amber
          : COLORS.red;
    parts.push(
      `<rect x="${x}" y="${HEADER / 2 - 8}" width="${w}" height="16" rx="8" fill="${fill}"/>`,
      `<text class="tag" x="${x + w / 2}" y="${HEADER / 2 + 3.5}" text-anchor="middle">${label}</text>`,
    );
  }
  if (card.note) {
    let note = card.note;
    const room = card.width - 24;
    while (note.length > 1 && measure(note, FONT.small) > room)
      note = note.slice(0, -2);
    if (note !== card.note) note = `${note.trimEnd()}…`;
    parts.push(
      `<text class="note" x="12" y="${HEADER + 14}">${esc(note)}</text>`,
    );
  }
  y = HEADER + (card.note ? NOTE : 0);
  for (const f of diff.fields) {
    const fs = compare ? f.status : "same";
    const field = f.item;
    const struck = fs === "removed" || st === "removed";
    const base = y + ROW / 2 + 4;
    const tip = [
      field.note,
      field.default !== null ? `default ${field.default}` : null,
      field.notNull ? "not null" : null,
      fs === "changed" && f.before
        ? `Changed: ${fieldChange(f.before, field)}`
        : null,
    ].filter(Boolean);
    parts.push(`<g class="field" data-name="${attr(fieldName(t, field))}">`);
    if (tip.length)
      parts.push(
        `<title>${esc(`${t.name}.${field.name}\n${tip.join("\n")}`)}</title>`,
      );
    parts.push(
      `<rect x="1" y="${y}" width="${card.width - 2}" height="${ROW}" fill="transparent"/>`,
    );
    parts.push(
      `<text class="fname${field.pk ? " pk" : ""}${struck ? " removed-text" : ""}" x="12" y="${base}">${esc(field.name)}</text>`,
    );
    if (field.note)
      parts.push(
        `<circle cx="${12 + measure(field.name, FONT.mono) + 6}" cy="${y + ROW / 2 - 3}" r="2" fill="${COLORS.blue}" opacity=".55"/>`,
      );
    let right = card.width - 12;
    const badges = fieldBadges(field);
    for (const b of [...badges].reverse()) {
      const label = b.toUpperCase();
      const w = measure(label, FONT.badge) + 8;
      right -= w;
      const isKey = b === "pk";
      parts.push(
        `<rect x="${right}" y="${y + 4}" width="${w}" height="14" rx="4" fill="${isKey ? COLORS.blueSoft : COLORS.panel}" stroke="${isKey ? COLORS.blueLine : COLORS.line}"/>`,
        `<text class="badge" x="${right + w / 2}" y="${y + 14}" text-anchor="middle" fill="${isKey ? COLORS.blue : COLORS.muted}">${label}</text>`,
      );
      right -= 6;
    }
    const type = fieldRight(field, f.before, fs);
    parts.push(
      `<text class="ftype${fs === "changed" && f.before?.type !== field.type ? " changed" : ""}${struck ? " removed-text" : ""}" x="${right}" y="${base}" text-anchor="end">${esc(type)}</text>`,
      `</g>`,
    );
    y += ROW;
  }
  parts.push(`</g>`);
  return parts.join("");
}

/**
 * The entity diagram as a standalone SVG. With `compare` off every item is
 * drawn plainly (that is also the export).
 */
export function erdSvg(
  diff: DataModelDiff,
  options: { compare: boolean; measure?: Measure },
): string {
  const measure = options.measure ?? estimateWidth;
  const compare = options.compare;
  const { cards, width, height } = layoutCards(diff, measure, compare);
  const byName = new Map(cards.map((c) => [c.diff.table.name, c]));
  const lines: string[] = [];
  for (const r of diff.relations) {
    const rel = r.item;
    const a = byName.get(rel.from.table);
    const b = byName.get(rel.to.table);
    if (!a || !b) continue;
    const ay = rowY(
      a,
      rel.from.fields.length === 1 ? rel.from.fields[0] : undefined,
    );
    const by = rowY(
      b,
      rel.to.fields.length === 1 ? rel.to.fields[0] : undefined,
    );
    const path = relationPath(a, ay, b, by);
    const st = compare ? r.status : "same";
    const changedFrom =
      st === "changed" && r.before
        ? ` (was ${r.before.from.cardinality}–${r.before.to.cardinality})`
        : "";
    lines.push(
      `<g class="relation" data-name="${attr(relationName(rel))}">`,
      `<title>${esc(`${relationKey(rel)}: ${rel.from.cardinality} to ${rel.to.cardinality}${changedFrom}`)}</title>`,
      `<path class="rel${statusClass(st, true)}" d="${path.d}"/>`,
      `<path d="${path.d}" fill="none" stroke="transparent" stroke-width="10"/>`,
      `<text class="card-text" x="${path.start.x}" y="${path.start.y - 5}" text-anchor="${path.start.anchor}">${rel.from.cardinality}</text>`,
      `<text class="card-text" x="${path.end.x}" y="${path.end.y - 5}" text-anchor="${path.end.anchor}">${rel.to.cardinality}</text>`,
      `</g>`,
    );
  }
  const body = cards.map((c) => drawCard(c, measure, compare)).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="kim-erd" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${STYLE}</style>` +
    `<g class="relations">${lines.join("")}</g>${body}</svg>`
  );
}
