/** The design types the viewer draws, and what the shell page hands it. */
export const DESIGN_TYPES = [
  "data-model",
  "architecture",
  "data-flow",
  "sequence",
  "state",
  "api",
] as const;
export type DesignType = (typeof DESIGN_TYPES)[number];

export interface DesignShell {
  type: DesignType;
  title: string;
  source: string;
  /** The repo version's source, when there is one. */
  base: string | null;
}

/** How an item compares with the repo version. */
export type Status = "same" | "added" | "changed" | "removed";

export interface ChangeCounts {
  added: number;
  changed: number;
  removed: number;
}

export const noChanges = (): ChangeCounts => ({
  added: 0,
  changed: 0,
  removed: 0,
});

export const count = (counts: ChangeCounts, status: Status): void => {
  if (status !== "same") counts[status] += 1;
};

/** The site's palette, for drawing and for the highlights. */
export const COLORS = {
  ink: "#0e0f11",
  muted: "#676c74",
  faint: "#9aa0a9",
  line: "#e4e6ea",
  lineStrong: "#d3d7dd",
  panel: "#f6f6f7",
  card: "#ffffff",
  canvas: "#eef0f3",
  blue: "#1f6bff",
  blueSoft: "#e8f0ff",
  blueLine: "#cfdcff",
  green: "#2fbf71",
  greenSoft: "#e3f7ec",
  greenInk: "#1a8f52",
  amber: "#d98a00",
  amberSoft: "#fff1d6",
  amberInk: "#8a5a00",
  red: "#d64545",
  redSoft: "#fde8e8",
  redInk: "#b42318",
} as const;

export const STATUS_COLORS: Record<
  Exclude<Status, "same">,
  { stroke: string; fill: string; ink: string }
> = {
  added: { stroke: COLORS.green, fill: COLORS.greenSoft, ink: COLORS.greenInk },
  changed: {
    stroke: COLORS.amber,
    fill: COLORS.amberSoft,
    ink: COLORS.amberInk,
  },
  removed: { stroke: COLORS.red, fill: COLORS.redSoft, ink: COLORS.redInk },
};
