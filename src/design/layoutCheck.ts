/**
 * Measures a laid-out design for what makes it hard to read: text too
 * small once it's fitted to its frame, connections that cross, run through
 * a shape, or carry a label over one. Each finding names what it's about
 * and what to change in the design's source to fix it, since the layout
 * engine, not the author, places things.
 */

export interface Point {
  x: number;
  y: number;
}

/** Something drawn as a box: a shape, or a table's card. */
export interface Box {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A connection, as the points its line passes through. */
export interface Line {
  name: string;
  from: string;
  to: string;
  points: Point[];
  label?: { w: number; h: number };
}

export interface Finding {
  /** Stable, for telling one problem from another across attempts. */
  code: string;
  severity: "error" | "warning";
  message: string;
  /** The element(s) it's about, by the names comments use. */
  subject?: string[];
  /** What was measured. */
  evidence?: Record<string, number>;
  /** Changes to the source that address it. */
  fixes: string[];
  line?: number | null;
  column?: number | null;
  /** The source line, when there is one. */
  text?: string;
}

/** The frame a design is shown in on the System tab, less its padding. */
export const FRAME = { w: 1280 - 32, h: 800 - 32 };
/** Below this, fitted text is hard to read on a laptop. */
export const MIN_TEXT_PX = 7.5;
/** At most this many findings of one kind; the rest are counted. */
const PER_CODE = 5;

const round = (n: number, places = 2) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * Text size once the whole design is scaled to fit its frame. One that
 * fits at full size is never scaled up, so it's only ever too big a design.
 */
export function readability(
  size: { w: number; h: number },
  smallestText: number,
  fixes: string[],
): Finding | null {
  const scale = Math.min(1, FRAME.w / size.w, FRAME.h / size.h);
  const shown = smallestText * scale;
  if (scale >= 1 || shown >= MIN_TEXT_PX) return null;
  return {
    code: "layout/text-too-small",
    severity: "warning",
    message: `At ${Math.round(size.w)}×${Math.round(size.h)}px the design is shrunk to ${Math.round(scale * 100)}% to fit its ${FRAME.w + 32}×${FRAME.h + 32} frame, so its smallest text shows at ${round(shown, 1)}px; under ${MIN_TEXT_PX}px is hard to read`,
    evidence: {
      width: Math.round(size.w),
      height: Math.round(size.h),
      fitScale: round(scale),
      smallestTextPx: smallestText,
      shownTextPx: round(shown, 1),
      minimumTextPx: MIN_TEXT_PX,
    },
    fixes,
  };
}

/** Points along a cubic Bézier route (start, then control, control, end…). */
export function sampleCurve(route: Point[], steps = 8): Point[] {
  if (route.length < 4 || (route.length - 1) % 3 !== 0) return route;
  const out: Point[] = [route[0]!];
  for (let i = 0; i + 3 < route.length; i += 3) {
    const [p0, c1, c2, p1] = [
      route[i]!,
      route[i + 1]!,
      route[i + 2]!,
      route[i + 3]!,
    ];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      out.push({
        x:
          u * u * u * p0.x +
          3 * u * u * t * c1.x +
          3 * u * t * t * c2.x +
          t * t * t * p1.x,
        y:
          u * u * u * p0.y +
          3 * u * u * t * c1.y +
          3 * u * t * t * c2.y +
          t * t * t * p1.y,
      });
    }
  }
  return out;
}

const cross = (o: Point, a: Point, b: Point) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Whether two segments cross at a point inside both (touching doesn't count). */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function segments(points: Point[]): Array<[Point, Point]> {
  const out: Array<[Point, Point]> = [];
  for (let i = 0; i + 1 < points.length; i++)
    out.push([points[i]!, points[i + 1]!]);
  return out;
}

/** Whether a segment passes through a box, shrunk by `inset` so grazing doesn't count. */
function segmentHitsBox(a: Point, b: Point, box: Box, inset = 2): boolean {
  const x0 = box.x + inset;
  const y0 = box.y + inset;
  const x1 = box.x + box.w - inset;
  const y1 = box.y + box.h - inset;
  if (x1 <= x0 || y1 <= y0) return false;
  const inside = (p: Point) => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1;
  if (inside(a) || inside(b)) return true;
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  return segments([...corners, corners[0]!]).some(([c, d]) =>
    segmentsCross(a, b, c, d),
  );
}

const boxesOverlap = (a: Box, b: Box, inset = 2) =>
  a.x + inset < b.x + b.w - inset &&
  b.x + inset < a.x + a.w - inset &&
  a.y + inset < b.y + b.h - inset &&
  b.y + inset < a.y + a.h - inset;

/** The point a fraction of the way along a line, by length. */
function along(points: Point[], fraction: number): Point {
  const parts = segments(points);
  const lengths = parts.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y));
  let left = lengths.reduce((s, l) => s + l, 0) * fraction;
  for (let i = 0; i < parts.length; i++) {
    const [a, b] = parts[i]!;
    const l = lengths[i]!;
    if (left <= l || i === parts.length - 1) {
      const t = l === 0 ? 0 : Math.min(1, left / l);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= l;
  }
  return points[0] ?? { x: 0, y: 0 };
}

/** Keeps the first few findings of a kind and says how many more there were. */
function capped(findings: Finding[]): Finding[] {
  if (findings.length <= PER_CODE) return findings;
  const kept = findings.slice(0, PER_CODE);
  const last = kept[kept.length - 1]!;
  kept[kept.length - 1] = {
    ...last,
    message: `${last.message} (and ${findings.length - PER_CODE} more like it)`,
  };
  return kept;
}

export interface LayoutRules {
  /** Whether a line may touch this box: its own ends and what holds them. */
  related: (line: Line, box: Box) => boolean;
  /** Whether two lines share an end, so meeting there isn't a crossing. */
  shareEnd: (a: Line, b: Line) => boolean;
  fixes: {
    crossing: string[];
    throughShape: string[];
    labelOverShape: string[];
  };
}

/** Crossings, lines through unrelated boxes, and labels over boxes. */
export function lineFindings(
  lines: Line[],
  boxes: Box[],
  rules: LayoutRules,
): Finding[] {
  const crossings: Finding[] = [];
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      if (rules.shareEnd(a, b)) continue;
      const hits = segments(a.points).some(([p, q]) =>
        segments(b.points).some(([r, s]) => segmentsCross(p, q, r, s)),
      );
      if (hits)
        crossings.push({
          code: "layout/crossing",
          severity: "warning",
          message: `${a.name} crosses ${b.name}`,
          subject: [a.name, b.name],
          fixes: rules.fixes.crossing,
        });
    }

  const through: Finding[] = [];
  for (const line of lines)
    for (const box of boxes) {
      if (rules.related(line, box)) continue;
      if (segments(line.points).some(([a, b]) => segmentHitsBox(a, b, box)))
        through.push({
          code: "layout/line-through-shape",
          severity: "warning",
          message: `${line.name} runs through ${box.name}, which it doesn't connect`,
          subject: [line.name, box.name],
          fixes: rules.fixes.throughShape,
        });
    }

  const labels: Finding[] = [];
  for (const line of lines) {
    if (!line.label || line.points.length < 2) continue;
    const at = along(line.points, 0.5);
    const rect: Box = {
      name: `${line.name} label`,
      x: at.x - line.label.w / 2,
      y: at.y - line.label.h / 2,
      w: line.label.w,
      h: line.label.h,
    };
    for (const box of boxes)
      if (!rules.related(line, box) && boxesOverlap(rect, box))
        labels.push({
          code: "layout/label-over-shape",
          severity: "warning",
          message: `${line.name}'s label sits on ${box.name}`,
          subject: [line.name, box.name],
          evidence: { labelWidthPx: Math.round(line.label.w) },
          fixes: rules.fixes.labelOverShape,
        });
  }
  return [...capped(crossings), ...capped(through), ...capped(labels)];
}
