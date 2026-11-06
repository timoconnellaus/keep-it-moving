import type { ChangeCounts } from "../types.js";

/** A design read and drawn, ready to show with or without the comparison. */
export interface Prepared {
  counts: ChangeCounts;
  /** False when there is no base, or the base would not parse. */
  comparable: boolean;
  draw(root: HTMLElement, compare: boolean): void;
  /** The plain design as a standalone SVG. */
  exportSvg(): string;
}

/** Throws the parser's error when `source` won't parse; a bad base just turns compare off. */
export type Prepare = (
  source: string,
  base: string | null,
) => Promise<Prepared>;

/** Parses the base, or returns null when it won't. */
export function tryParse<T>(
  parse: (s: string) => T,
  base: string | null,
): T | null {
  if (base === null) return null;
  try {
    return parse(base);
  } catch {
    return null;
  }
}
