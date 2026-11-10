import {
  count,
  noChanges,
  STATUS_COLORS,
  type ChangeCounts,
  type Status,
} from "./types.js";

/**
 * D2 designs (architecture, data flow): compare the compiled graphs, then
 * annotate a copy of the source so the render shows the changes. Pure; the
 * wasm compile and render live in d2Render.ts.
 */

export interface D2Shape {
  /** D2's absolute id, like `cloud.worker` or `"a.b"`. */
  id: string;
  label: string;
  type: string;
  /** Everything about it that isn't layout, for spotting changes. */
  signature: string;
}

export interface D2Connection {
  /** Like `cloud.(w -> q)[0]`. */
  id: string;
  src: string;
  dst: string;
  label: string;
  signature: string;
}

export interface D2Graph {
  shapes: D2Shape[];
  connections: D2Connection[];
}

type Loose = Record<string, unknown>;

const SHAPE_KEYS = [
  "type",
  "label",
  "fill",
  "stroke",
  "strokeDash",
  "strokeWidth",
  "borderRadius",
  "opacity",
  "shadow",
  "3d",
  "multiple",
  "double-border",
  "tooltip",
  "link",
  "icon",
  "fields",
  "methods",
  "columns",
  "language",
  "color",
  "bold",
  "italic",
  "underline",
  "fillPattern",
];
const CONNECTION_KEYS = [
  "src",
  "dst",
  "label",
  "srcArrow",
  "dstArrow",
  "stroke",
  "strokeDash",
  "strokeWidth",
  "srcLabel",
  "dstLabel",
  "animated",
  "tooltip",
  "link",
  "icon",
  "color",
];

const pick = (o: Loose, keys: string[]) =>
  JSON.stringify(keys.map((k) => o[k] ?? null));

/** The parts of a compiled d2 diagram we compare. */
export function graphFromDiagram(diagram: {
  shapes?: unknown[];
  connections?: unknown[];
}): D2Graph {
  const shapes = (diagram.shapes ?? []).map((s) => {
    const o = s as Loose;
    const id = String(o.id);
    return {
      id,
      label: typeof o.label === "string" ? o.label : lastSegment(id),
      type: String(o.type ?? "rectangle"),
      signature: pick(o, SHAPE_KEYS),
    };
  });
  const connections = (diagram.connections ?? []).map((c) => {
    const o = c as Loose;
    // srcLabel/dstLabel are objects in newer d2 builds; the JSON covers both.
    return {
      id: String(o.id),
      src: String(o.src),
      dst: String(o.dst),
      label: typeof o.label === "string" ? o.label : "",
      signature: pick(o, CONNECTION_KEYS),
    };
  });
  return { shapes, connections };
}

/** Splits a d2 key on dots outside quotes. */
export function splitKey(id: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of id) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ".") {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

const lastSegment = (id: string) => unquote(splitKey(id).pop() ?? id);
const unquote = (s: string) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);

/** A d2 key segment as source: quoted unless it is a plain name. */
const segment = (s: string) =>
  /^["']/.test(s) || /^[\w-]+$/.test(s) ? s : JSON.stringify(s);
export const keyToSource = (id: string) => splitKey(id).map(segment).join(".");

interface ParsedConnection {
  /** The container path, empty at the root. */
  scope: string;
  src: string;
  arrow: string;
  dst: string;
  index: number;
}

/** `cloud.(w -> q)[0]` → scope `cloud`, w, ->, q, 0. */
export function parseConnectionId(id: string): ParsedConnection | null {
  const m = /^(?:(.*)\.)?\((.+?) (<->|->|<-|--) (.+)\)\[(\d+)\]$/.exec(id);
  if (!m) return null;
  return {
    scope: m[1] ?? "",
    src: m[2]!,
    arrow: m[3]!,
    dst: m[4]!,
    index: Number(m[5]),
  };
}

const connectionGroup = (id: string) => id.replace(/\[\d+\]$/, "");

export interface D2Diff {
  shapes: Map<string, Status>;
  connections: Map<string, Status>;
  removedShapes: D2Shape[];
  removedConnections: D2Connection[];
  counts: ChangeCounts;
}

/**
 * Shapes match by id. Connections match within each `(a -> b)` group:
 * identical ones first, then the rest in order as changed, and the leftovers
 * are added or removed. That way deleting the first of two parallel edges
 * reads as one removal rather than a change plus a removal.
 */
export function diffD2(base: D2Graph, current: D2Graph): D2Diff {
  const counts = noChanges();
  const shapes = new Map<string, Status>();
  const baseShapes = new Map(base.shapes.map((s) => [s.id, s]));
  const currentIds = new Set(current.shapes.map((s) => s.id));
  for (const s of current.shapes) {
    const before = baseShapes.get(s.id);
    const status: Status = !before
      ? "added"
      : before.signature === s.signature
        ? "same"
        : "changed";
    shapes.set(s.id, status);
    count(counts, status);
  }
  const removedShapes = base.shapes.filter((s) => !currentIds.has(s.id));
  for (let k = 0; k < removedShapes.length; k++) count(counts, "removed");

  const connections = new Map<string, Status>();
  const removedConnections: D2Connection[] = [];
  const groups = new Map<
    string,
    { base: D2Connection[]; current: D2Connection[] }
  >();
  const groupOf = (id: string) => {
    const key = connectionGroup(id);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { base: [], current: [] }));
    return g;
  };
  for (const c of base.connections) groupOf(c.id).base.push(c);
  for (const c of current.connections) groupOf(c.id).current.push(c);
  for (const g of groups.values()) {
    const left = [...g.base];
    const unmatched: D2Connection[] = [];
    for (const c of g.current) {
      const i = left.findIndex((b) => b.signature === c.signature);
      if (i >= 0) {
        left.splice(i, 1);
        connections.set(c.id, "same");
      } else unmatched.push(c);
    }
    for (const c of unmatched) {
      const status: Status = left.length ? "changed" : "added";
      if (left.length) left.shift();
      connections.set(c.id, status);
      count(counts, status);
    }
    for (const b of left) {
      removedConnections.push(b);
      count(counts, "removed");
    }
  }
  return { shapes, connections, removedShapes, removedConnections, counts };
}

const STYLE: Record<Exclude<Status, "same">, string[]> = {
  added: [
    `fill: "${STATUS_COLORS.added.fill}"`,
    `stroke: "${STATUS_COLORS.added.stroke}"`,
    "stroke-width: 3",
  ],
  changed: [
    `fill: "${STATUS_COLORS.changed.fill}"`,
    `stroke: "${STATUS_COLORS.changed.stroke}"`,
    "stroke-width: 3",
  ],
  removed: [
    `fill: "${STATUS_COLORS.removed.fill}"`,
    `stroke: "${STATUS_COLORS.removed.stroke}"`,
    "stroke-dash: 4",
    `font-color: "${STATUS_COLORS.removed.ink}"`,
    "opacity: 0.85",
  ],
};
// Connections have no fill.
const EDGE_STYLE: Record<Exclude<Status, "same">, string[]> = {
  added: [`stroke: "${STATUS_COLORS.added.stroke}"`, "stroke-width: 3"],
  changed: [`stroke: "${STATUS_COLORS.changed.stroke}"`, "stroke-width: 3"],
  removed: [
    `stroke: "${STATUS_COLORS.removed.stroke}"`,
    "stroke-dash: 4",
    `font-color: "${STATUS_COLORS.removed.ink}"`,
  ],
};

const styleLines = (key: string, styles: string[]) =>
  styles.map((s) => `${key}.style.${s}`);

/**
 * A copy of `source` that draws the comparison: removed shapes and
 * connections are added back, and every changed item gets a fill, stroke and
 * dash. Everything is appended, so line numbers in the original stay put.
 */
export function annotateD2(
  source: string,
  diff: D2Diff,
  current: D2Graph,
): string {
  const out: string[] = [
    source.replace(/\s*$/, ""),
    "",
    "# kim: compare with the repo version",
  ];
  // Parents before children, so a removed container exists before its contents.
  const removed = [...diff.removedShapes].sort(
    (a, b) => splitKey(a.id).length - splitKey(b.id).length,
  );
  for (const s of removed) {
    const key = keyToSource(s.id);
    out.push(`${key}: ${JSON.stringify(s.label)}`);
    if (s.type && s.type !== "rectangle") out.push(`${key}.shape: ${s.type}`);
    out.push(...styleLines(key, STYLE.removed));
  }
  for (const [id, status] of diff.shapes)
    if (status !== "same")
      out.push(...styleLines(keyToSource(id), STYLE[status]));
  // Re-added connections take the next index in their group.
  const nextIndex = new Map<string, number>();
  for (const c of current.connections) {
    const g = connectionGroup(c.id);
    nextIndex.set(g, (nextIndex.get(g) ?? 0) + 1);
  }
  const readded: string[] = [];
  for (const c of diff.removedConnections) {
    const p = parseConnectionId(c.id);
    if (!p) continue;
    const g = connectionGroup(c.id);
    const index = nextIndex.get(g) ?? 0;
    nextIndex.set(g, index + 1);
    const src = keyToSource(p.src);
    const dst = keyToSource(p.dst);
    const edge = `${src} ${p.arrow} ${dst}${c.label ? `: ${JSON.stringify(c.label)}` : ""}`;
    const scope = p.scope ? keyToSource(p.scope) : "";
    out.push(scope ? `${scope}: {\n  ${edge}\n}` : edge);
    readded.push(
      ...styleLines(
        `${scope ? `${scope}.` : ""}(${src} ${p.arrow} ${dst})[${index}]`,
        EDGE_STYLE.removed,
      ),
    );
  }
  out.push(...readded);
  for (const [id, status] of diff.connections) {
    if (status === "same") continue;
    const p = parseConnectionId(id);
    if (!p) continue;
    const scope = p.scope ? `${keyToSource(p.scope)}.` : "";
    out.push(
      ...styleLines(
        `${scope}(${keyToSource(p.src)} ${p.arrow} ${keyToSource(p.dst)})[${p.index}]`,
        EDGE_STYLE[status],
      ),
    );
  }
  return `${out.join("\n")}\n`;
}

/** Plain names for pins: the shape's label, `a → b` for a connection. */
export function d2Names(graph: D2Graph): Map<string, string> {
  const names = new Map<string, string>();
  const labels = new Map(
    graph.shapes.map((s) => [s.id, s.label || lastSegment(s.id)]),
  );
  for (const s of graph.shapes) names.set(s.id, s.label || lastSegment(s.id));
  for (const c of graph.connections) {
    const from = labels.get(c.src) ?? lastSegment(c.src);
    const to = labels.get(c.dst) ?? lastSegment(c.dst);
    names.set(c.id, `${from} → ${to}${c.label ? `: ${c.label}` : ""}`);
  }
  return names;
}

const unescapeHtml = (s: string) =>
  s
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** D2 classes each element with base64 of its HTML-escaped id. */
export function decodeD2Class(token: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || token.length % 4 !== 0)
    return null;
  try {
    const bytes = Uint8Array.from(atob(token), (c) => c.charCodeAt(0));
    return unescapeHtml(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return null;
  }
}

/**
 * Adds data-name to every shape and connection group in a d2 SVG string,
 * and data-kim-status to the ones that changed.
 */
export function nameD2Svg(
  svg: string,
  names: Map<string, string>,
  statuses: Map<string, Status> = new Map(),
): string {
  return svg.replace(/<g class="([^"]+)"/g, (whole, cls: string) => {
    for (const token of cls.split(/\s+/)) {
      const id = decodeD2Class(token);
      const name = id === null ? undefined : names.get(id);
      if (name !== undefined) {
        const status = statuses.get(id!);
        return `${whole} data-name="${name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"${status && status !== "same" ? ` data-kim-status="${status}"` : ""}`;
      }
    }
    return whole;
  });
}

/** What connects to what, by the names the drawing carries. */
export function d2Links(
  graph: D2Graph,
  names: Map<string, string>,
): Array<{ edge: string; from: string; to: string }> {
  return graph.connections.flatMap((c) => {
    const edge = names.get(c.id);
    const from = names.get(c.src);
    const to = names.get(c.dst);
    return edge && from && to ? [{ edge, from, to }] : [];
  });
}
