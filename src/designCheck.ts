import { parseApi } from "./design/api.js";
import { parseDataModel, plainDataModel } from "./design/dataModel.js";
import { layoutCards } from "./design/erd.js";
import { describeErrors } from "./design/errors.js";
import {
  FRAME,
  lineFindings,
  readability,
  sampleCurve,
  type Box,
  type Finding,
  type Line,
  type Point,
} from "./design/layoutCheck.js";
import { estimateWidth } from "./design/svg.js";
import type { DesignType } from "./shared/designs.js";

export type { Finding } from "./design/layoutCheck.js";

/**
 * A design that won't draw, refused before it's saved. `details` is what
 * the agent reads: each problem, where it is, the line itself, and what to do.
 */
export class DesignCheckError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DesignCheckError";
  }
}

/** What's wrong with a design: errors stop it being saved, warnings don't. */
export interface DesignReport {
  errors: Finding[];
  warnings: Finding[];
}

/** Mermaid's name for each diagram a design type accepts. */
const MERMAID_DIAGRAMS: Partial<Record<DesignType, string[]>> = {
  sequence: ["sequence"],
  state: ["stateDiagram", "state"],
};

const MERMAID_HEADER: Partial<Record<DesignType, string>> = {
  sequence: "sequenceDiagram",
  state: "stateDiagram-v2",
};

class WrongDiagram extends Error {}

/** What D2's compiler hands back, as far as the checks read it. */
interface D2Diagram {
  shapes: Array<{
    id: string;
    pos: Point;
    width: number;
    height: number;
    label?: string;
    fontSize?: number;
  }>;
  connections: Array<{
    src: string;
    dst: string;
    route: Point[];
    isCurve?: boolean;
    label?: string;
    fontSize?: number;
    labelWidth?: number;
    labelHeight?: number;
  }>;
}

/** D2 runs as wasm in a worker thread, which must end for the CLI to exit. */
async function compileD2(source: string): Promise<D2Diagram> {
  const { D2 } = await import("@terrastruct/d2");
  const d2 = new D2();
  try {
    const result = await d2.compile({
      fs: { index: source },
      options: { layout: "dagre" },
    });
    return result.diagram as unknown as D2Diagram;
  } finally {
    // Not in its types: the worker is made once `ready` resolves.
    const internals = d2 as unknown as {
      ready: Promise<unknown>;
      worker?: { terminate(): unknown };
    };
    await internals.ready.catch(() => undefined);
    await internals.worker?.terminate();
  }
}

/** The padding the viewer draws a D2 design with. */
const D2_PAD = 24;

/** Whether `a` is `b`, or holds it (`a` is a container of `b`). */
const holds = (a: string, b: string) => a === b || b.startsWith(`${a}.`);

function d2Findings(diagram: D2Diagram): Finding[] {
  const ids = diagram.shapes.map((s) => s.id);
  const containers = new Set(
    ids.filter((id) => ids.some((other) => other.startsWith(`${id}.`))),
  );
  const boxes: Box[] = diagram.shapes
    .filter((s) => !containers.has(s.id))
    .map((s) => ({
      name: s.id,
      x: s.pos.x,
      y: s.pos.y,
      w: s.width,
      h: s.height,
    }));
  const lines: Line[] = diagram.connections.map((c) => ({
    name: `${c.src} -> ${c.dst}`,
    from: c.src,
    to: c.dst,
    points: c.isCurve ? sampleCurve(c.route) : c.route,
    ...(c.label && c.labelWidth && c.labelHeight
      ? { label: { w: c.labelWidth, h: c.labelHeight } }
      : {}),
  }));

  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of diagram.shapes) {
    xs.push(s.pos.x, s.pos.x + s.width);
    ys.push(s.pos.y, s.pos.y + s.height);
  }
  for (const c of diagram.connections)
    for (const p of c.route) {
      xs.push(p.x);
      ys.push(p.y);
    }
  if (xs.length === 0) return [];
  const size = {
    w: Math.max(...xs) - Math.min(...xs) + 2 * D2_PAD,
    h: Math.max(...ys) - Math.min(...ys) + 2 * D2_PAD,
  };
  const texts = [
    ...diagram.shapes.filter((s) => s.label).map((s) => s.fontSize ?? 16),
    ...diagram.connections.filter((c) => c.label).map((c) => c.fontSize ?? 16),
  ];
  const wide = size.w / size.h > (FRAME.w / FRAME.h) * 1.4;
  const tall = size.h / size.w > (FRAME.h / FRAME.w) * 1.4;
  const findings: Finding[] = [];
  const small = readability(size, Math.min(16, ...texts), [
    ...(wide || tall
      ? [
          `It's much ${wide ? "wider" : "taller"} than its frame: try the other \`direction\` (D2 lays out down unless told \`direction: right\`) and keep whichever fits better`,
        ]
      : []),
    "Split it: keep this design to the overview and give a busy container a design of its own",
    "Group related shapes in containers, so fewer boxes sit side by side",
  ]);
  if (small) findings.push(small);

  const regroup =
    "Put the shapes involved in one container, or declare each shape next to the ones it connects to: the layout orders a row by declaration";
  findings.push(
    ...lineFindings(lines, boxes, {
      related: (line, box) =>
        holds(box.name, line.from) || holds(box.name, line.to),
      shareEnd: (a, b) =>
        [a.from, a.to].some((x) =>
          [b.from, b.to].some((y) => holds(x, y) || holds(y, x)),
        ),
      fixes: {
        crossing: [regroup, "Try the other `direction` (right or down)"],
        throughShape: [
          regroup,
          "Connect to the container rather than a shape inside it",
        ],
        labelOverShape: [
          "Shorten the label, keeping what it means (aim for 17 characters or fewer), and move detail into a `#` comment",
          regroup,
        ],
      },
    }),
  );
  return findings;
}

/** The ERD lays itself out; all the author can change is how much it holds. */
function dataModelFindings(source: string): Finding[] {
  const layout = layoutCards(
    plainDataModel(parseDataModel(source)),
    estimateWidth,
    false,
  );
  // Field rows are the smallest text that matters (11.5px mono).
  const small = readability({ w: layout.width, h: layout.height }, 11.5, [
    "Split the schema into one design per area (such as billing.dbml and accounts.dbml); a table another area refers to can appear in both",
    `It holds ${layout.cards.length} tables; keep only the ones this plan touches, and mention the rest in a Note`,
  ]);
  return small ? [small] : [];
}

async function checkMermaid(type: DesignType, source: string): Promise<void> {
  // Mermaid sanitizes labels with DOMPurify, which needs a DOM to exist.
  // Only parsing happens here, nothing is drawn, so text can pass as is.
  const { default: purify } = await import("dompurify");
  if (!purify.isSupported) {
    purify.addHook = () => undefined;
    purify.sanitize = ((text: string) => text) as typeof purify.sanitize;
  }
  const { default: mermaid } = await import("mermaid");
  const { diagramType } = await mermaid.parse(source);
  const accepted = MERMAID_DIAGRAMS[type] ?? [];
  if (!accepted.includes(diagramType))
    throw new WrongDiagram(
      `This is a Mermaid ${diagramType} diagram, but a ${type} design is drawn from \`${MERMAID_HEADER[type]}\``,
    );
}

/** The fix each syntax error gets: the parser's message says what's wrong. */
const PARSE_FIX =
  "Fix the source at this line; the message says what the parser expected";

/**
 * Parses a design with the engine the viewer draws it with, then measures
 * how it lays out (D2 and DBML; Mermaid lays out only in a browser).
 */
export async function inspectDesign(
  type: DesignType,
  source: string,
): Promise<DesignReport> {
  const lines = source.split("\n");
  let warnings: Finding[] = [];
  try {
    if (type === "data-model") warnings = dataModelFindings(source);
    else if (type === "api") parseApi(source);
    else if (type === "architecture" || type === "data-flow")
      warnings = d2Findings(await compileD2(source));
    else await checkMermaid(type, source);
    return { errors: [], warnings };
  } catch (error) {
    const wrong = error instanceof WrongDiagram;
    return {
      warnings: [],
      errors: describeErrors(error).map((problem) => ({
        code: wrong ? "design/wrong-diagram" : "design/syntax",
        severity: "error",
        message: problem.message,
        line: problem.line,
        column: problem.column,
        ...(problem.line !== null && lines[problem.line - 1] !== undefined
          ? { text: lines[problem.line - 1]! }
          : {}),
        fixes: wrong
          ? [
              `Start the file with \`${MERMAID_HEADER[type]}\`, or add it as the design type it is`,
            ]
          : [PARSE_FIX],
      })),
    };
  }
}

/** At most this many errors are reported at once; fixing them often fixes the rest. */
const MAX_ERRORS = 8;

/**
 * Throws a DesignCheckError when the design won't draw; otherwise returns
 * its layout warnings, which don't stop it being saved.
 */
export async function checkDesign(
  type: DesignType,
  source: string,
  file: string | undefined,
): Promise<Finding[]> {
  const report = await inspectDesign(type, source);
  if (report.errors.length === 0) return report.warnings;
  const first = report.errors[0]!;
  const name = file && file !== "-" ? file : `this ${type} design`;
  const place =
    first.line == null
      ? ""
      : first.column == null
        ? ` (line ${first.line})`
        : ` (line ${first.line}, column ${first.column})`;
  const more =
    report.errors.length > 1 ? `, and ${report.errors.length - 1} more` : "";
  throw new DesignCheckError(
    `${name} won't draw, so it wasn't saved${place}: ${first.message}${more}`,
    {
      diagnostics: report.errors.slice(0, MAX_ERRORS),
      ...(report.errors.length > MAX_ERRORS
        ? { omitted: report.errors.length - MAX_ERRORS }
        : {}),
      fix: "Fix the design file and run the same command again.",
    },
  );
}
