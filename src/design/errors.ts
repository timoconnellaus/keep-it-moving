/** A design that would not parse: what went wrong and where (1-based). */
export interface DesignError {
  message: string;
  line: number | null;
  column: number | null;
}

/** Thrown by our own parsers, already carrying its place. */
export class DesignParseError extends Error {
  constructor(
    message: string,
    readonly line: number | null = null,
    readonly column: number | null = null,
    /** Every problem, each at its own place, when the parser found several. */
    readonly problems: DesignError[] = [],
  ) {
    super(message);
    this.name = "DesignParseError";
  }
}

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose =>
  typeof v === "object" && v !== null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** D2's `index:3:5: message` (the wasm build reports this, sometimes as JSON). */
function d2Problems(message: string): DesignError[] {
  let entries: string[] = [];
  try {
    const parsed: unknown = JSON.parse(message);
    if (Array.isArray(parsed))
      entries = parsed
        .map((e) =>
          isObject(e) && typeof e.errmsg === "string" ? e.errmsg : "",
        )
        .filter(Boolean);
  } catch {
    entries = message.split("\n").filter(Boolean);
  }
  return entries
    .map((e) => /^[^:\n]*:(\d+):(\d+):\s*([\s\S]*)$/.exec(e))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ message: m[3]!, line: Number(m[1]), column: Number(m[2]) }));
}

function fromD2Message(message: string): DesignError | null {
  const located = d2Problems(message);
  if (located.length === 0) return null;
  return {
    message: located.map((p) => p.message).join("\n"),
    line: located[0]!.line,
    column: located[0]!.column,
  };
}

/**
 * Every problem a parser reported, each at its own place; one, when it
 * reported a single error or didn't say where the others were.
 */
export function describeErrors(error: unknown): DesignError[] {
  if (error instanceof DesignParseError && error.problems.length > 0)
    return error.problems;
  if (error instanceof Error) {
    const d2 = d2Problems(error.message);
    if (d2.length > 0) return d2;
  }
  return [describeError(error)];
}

/**
 * Turns whatever a parser threw into a message and a place. Knows the shapes
 * thrown by @dbml/core (diags), yaml (linePos), Mermaid (hash.loc or "on line
 * N"), D2 (index:L:C) and our own DesignParseError.
 */
export function describeError(error: unknown): DesignError {
  if (error instanceof DesignParseError)
    return { message: error.message, line: error.line, column: error.column };
  if (isObject(error)) {
    // @dbml/core: { diags: [{ message, location: { start: { line, column } } }] }
    if (Array.isArray(error.diags) && error.diags.length > 0) {
      const diags = error.diags.filter(isObject);
      const first = diags[0];
      const start =
        first && isObject(first.location) && isObject(first.location.start)
          ? first.location.start
          : {};
      return {
        message: diags
          .map((d) => (typeof d.message === "string" ? d.message : String(d)))
          .join("\n"),
        line: num(start.line),
        column: num(start.column),
      };
    }
    // yaml: YAMLParseError { linePos: [{ line, col }] }
    if (Array.isArray(error.linePos) && isObject(error.linePos[0])) {
      const message = typeof error.message === "string" ? error.message : "";
      return {
        message: message
          .split("\n")[0]!
          .replace(/ at line \d+, column \d+:?$/, ""),
        line: num(error.linePos[0].line),
        column: num(error.linePos[0].col),
      };
    }
    // Mermaid (jison): { hash: { loc: { first_line, first_column } } }
    const hash = error.hash;
    if (isObject(hash) && isObject(hash.loc)) {
      const message = typeof error.message === "string" ? error.message : "";
      return {
        message: mermaidMessage(message),
        line: num(hash.loc.first_line),
        column: (num(hash.loc.first_column) ?? 0) + 1,
      };
    }
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "This design could not be read.";
  const d2 = fromD2Message(message);
  if (d2) return d2;
  const onLine = /\bon line (\d+)/i.exec(message);
  return {
    message: mermaidMessage(message),
    line: onLine ? Number(onLine[1]) : null,
    column: null,
  };
}

/** Mermaid's messages carry a code frame; keep the words. */
function mermaidMessage(message: string): string {
  const lines = message.split("\n");
  if (/^Parse error on line \d+:?$/.test(lines[0] ?? "") && lines.length >= 4) {
    const expecting = lines.slice(3).join(" ");
    const got = /got '([^']+)'/.exec(expecting);
    const wanted = /Expecting (.+), got/.exec(expecting);
    const tidy = (t: string) =>
      t.replace(/'/g, "").toLowerCase().replace(/_/g, " ");
    const options = wanted ? wanted[1]!.split(", ").map(tidy) : [];
    const shown =
      options.length > 4
        ? `${options.slice(0, 4).join(", ")} or ${options.length - 4} more`
        : options.join(", ");
    return got
      ? `Unexpected ${got[1] === "TXT" ? "text" : tidy(got[1]!)}${shown ? `; expected ${shown}` : ""}`
      : lines.slice(3).join(" ");
  }
  return message.trim() || "This design could not be read.";
}

export interface SourceLine {
  number: number;
  text: string;
  bad: boolean;
}

/** The source, numbered, with the bad line marked. */
export function sourceLines(source: string, line: number | null): SourceLine[] {
  const lines = source.split("\n");
  // A final newline doesn't make a line of its own, unless the error is there.
  if (
    lines.length > 1 &&
    lines[lines.length - 1] === "" &&
    line !== lines.length
  )
    lines.pop();
  return lines.map((text, index) => ({
    number: index + 1,
    text,
    bad: line === index + 1,
  }));
}

/** "Line 3, column 5" or nothing when the parser did not say. */
export function placeLabel(error: DesignError): string {
  if (error.line === null) return "";
  return error.column === null
    ? `Line ${error.line}`
    : `Line ${error.line}, column ${error.column}`;
}
