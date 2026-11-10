import { parseApi } from "./design/api.js";
import { parseDataModel } from "./design/dataModel.js";
import { describeError, type DesignError } from "./design/errors.js";
import type { DesignType } from "./shared/designs.js";

/**
 * A design that won't draw, refused before it's saved. `details` is what
 * the agent reads: where the problem is, the line itself, and what to do.
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

/** Mermaid's name for each diagram a design type accepts. */
const MERMAID_DIAGRAMS: Partial<Record<DesignType, string[]>> = {
  sequence: ["sequence"],
  state: ["stateDiagram", "state"],
};

const MERMAID_HEADER: Partial<Record<DesignType, string>> = {
  sequence: "sequenceDiagram",
  state: "stateDiagram-v2",
};

/** D2 runs as wasm in a worker thread, which must end for the CLI to exit. */
async function checkD2(source: string): Promise<void> {
  const { D2 } = await import("@terrastruct/d2");
  const d2 = new D2();
  try {
    await d2.compile({ fs: { index: source }, options: { layout: "dagre" } });
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
    throw new Error(
      `This is a Mermaid ${diagramType} diagram, but a ${type} design is drawn from \`${MERMAID_HEADER[type]}\``,
    );
}

/**
 * Parses a design with the same engine the viewer draws it with, and
 * returns what's wrong, or null when it will draw.
 */
export async function designProblem(
  type: DesignType,
  source: string,
): Promise<DesignError | null> {
  try {
    if (type === "data-model") parseDataModel(source);
    else if (type === "api") parseApi(source);
    else if (type === "architecture" || type === "data-flow")
      await checkD2(source);
    else await checkMermaid(type, source);
    return null;
  } catch (error) {
    return describeError(error);
  }
}

/** Throws a DesignCheckError when the design won't draw. */
export async function checkDesign(
  type: DesignType,
  source: string,
  file: string | undefined,
): Promise<void> {
  const problem = await designProblem(type, source);
  if (!problem) return;
  const name = file && file !== "-" ? file : `this ${type} design`;
  const place =
    problem.line === null
      ? ""
      : problem.column === null
        ? ` (line ${problem.line})`
        : ` (line ${problem.line}, column ${problem.column})`;
  const text =
    problem.line === null ? undefined : source.split("\n")[problem.line - 1];
  throw new DesignCheckError(
    `${name} won't draw, so it wasn't saved${place}: ${problem.message}`,
    {
      design: {
        type,
        message: problem.message,
        line: problem.line,
        column: problem.column,
        ...(text === undefined ? {} : { text }),
      },
      fix: "Fix the design file and run the same command again.",
    },
  );
}
