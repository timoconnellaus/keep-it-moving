import { align, matchByKey, type Merged } from "./align.js";
import {
  count,
  noChanges,
  STATUS_COLORS,
  type ChangeCounts,
  type Status,
} from "./types.js";

/**
 * Mermaid state diagrams (stateDiagram-v2), read line by line to compare
 * states and transitions and to annotate a copy of the source.
 */

export interface State {
  id: string;
  /** The label: `state "Label" as Id`, else the descriptions, else the id. */
  label: string;
  /** The composite state it sits in, or "" at the top. */
  parent: string;
  composite: boolean;
}

export interface Transition {
  /** `[*]` is scoped to its composite: `Parent/[*]`. */
  from: string;
  to: string;
  label: string;
  line: number;
}

export interface StateModel {
  states: State[];
  transitions: Transition[];
}

const ID = "[\\w.$\\-]+";
const TRANSITION = new RegExp(
  `^(\\[\\*\\]|${ID})(?::::\\w+)?\\s*-->\\s*(\\[\\*\\]|${ID})(?::::\\w+)?\\s*(?::\\s*(.*))?$`,
);

export function parseState(source: string): StateModel {
  const states = new Map<string, State>();
  const descriptions = new Map<string, string[]>();
  const transitions: Transition[] = [];
  const scopes: string[] = [];
  const scope = () => scopes[scopes.length - 1] ?? "";
  const see = (id: string, composite = false) => {
    if (id === "[*]") return;
    const existing = states.get(id);
    if (existing) {
      if (composite) existing.composite = true;
      return;
    }
    states.set(id, { id, label: id, parent: scope(), composite });
  };
  const lines = source.split("\n");
  let inNote = false;
  lines.forEach((raw, line) => {
    const text = raw.trim();
    if (!text || text.startsWith("%%")) return;
    if (inNote) {
      if (/^end\s+note$/i.test(text)) inNote = false;
      return;
    }
    if (
      /^stateDiagram(-v2)?\b/.test(text) ||
      /^(direction|classDef|class|style|accTitle|accDescr|title)\b/.test(text)
    )
      return;
    if (/^note\b/i.test(text)) {
      if (!text.includes(":")) inNote = true;
      return;
    }
    if (text === "}") {
      scopes.pop();
      return;
    }
    if (text === "--") return;
    let m = new RegExp(`^state\\s+"([^"]*)"\\s+as\\s+(${ID})\\s*(\\{)?`).exec(
      text,
    );
    if (m) {
      see(m[2]!, Boolean(m[3]));
      states.get(m[2]!)!.label = m[1]!;
      if (m[3]) scopes.push(m[2]!);
      return;
    }
    m = new RegExp(`^state\\s+(${ID})(?:\\s+<<\\w+>>)?\\s*(\\{)?`).exec(text);
    if (m) {
      see(m[1]!, Boolean(m[2]));
      if (m[2]) scopes.push(m[1]!);
      return;
    }
    m = TRANSITION.exec(text);
    if (m) {
      const at = (id: string) => (id === "[*]" ? `${scope()}/[*]` : id);
      see(m[1]!);
      see(m[2]!);
      transitions.push({
        from: at(m[1]!),
        to: at(m[2]!),
        label: (m[3] ?? "").trim(),
        line,
      });
      return;
    }
    m = new RegExp(`^(${ID})(?::::\\w+)?\\s*:\\s*(.*)$`).exec(text);
    if (m) {
      see(m[1]!);
      descriptions.set(m[1]!, [
        ...(descriptions.get(m[1]!) ?? []),
        m[2]!.trim(),
      ]);
      return;
    }
    m = new RegExp(`^(${ID})(?::::\\w+)?$`).exec(text);
    if (m) see(m[1]!);
  });
  for (const [id, d] of descriptions) {
    const s = states.get(id);
    if (s && s.label === id) s.label = d.join(" ");
  }
  return { states: [...states.values()], transitions };
}

export interface StateDiff {
  states: Merged<State>[];
  transitions: Merged<Transition>[];
  counts: ChangeCounts;
}

const transitionKey = (t: Transition) =>
  `${t.from}\u0000${t.to}\u0000${t.label}`;

export function diffState(base: StateModel, current: StateModel): StateDiff {
  const counts = noChanges();
  const states = matchByKey(
    base.states,
    current.states,
    (s) => s.id,
    (a, b) => a.label === b.label && a.parent === b.parent,
  );
  // Sorted by key so moving a line around isn't a change.
  const sort = (ts: Transition[]) =>
    [...ts].sort((a, b) => transitionKey(a).localeCompare(transitionKey(b)));
  const transitions = align(
    sort(base.transitions),
    sort(current.transitions),
    transitionKey,
    {
      group: (t) => `${t.from}\u0000${t.to}`,
    },
  );
  for (const e of [...states, ...transitions]) count(counts, e.status);
  return { states, transitions, counts };
}

const CLASS: Record<Exclude<Status, "same">, string> = {
  added: "kimAdded",
  changed: "kimChanged",
  removed: "kimRemoved",
};

const classDef = (status: Exclude<Status, "same">) => {
  const c = STATUS_COLORS[status];
  const dash = status === "removed" ? ",stroke-dasharray:5 4" : "";
  return `classDef ${CLASS[status]} fill:${c.fill},stroke:${c.stroke},stroke-width:2px,color:${c.ink}${dash}`;
};

export interface AnnotatedState {
  source: string;
  /** Status per transition, in the order of the annotated source. */
  transitions: { status: Status; transition: Transition }[];
}

/**
 * A copy of the source with classDefs for the changed states, and removed
 * states and transitions put back at the end. Transitions are coloured
 * afterwards in the SVG, from `transitions` (Mermaid numbers edges in
 * source order).
 */
export function annotateState(
  source: string,
  current: StateModel,
  diff: StateDiff,
): AnnotatedState {
  const lines = source.replace(/\s*$/, "").split("\n");
  const statusOf = new Map<string, Status>();
  for (const t of diff.transitions)
    if (t.status !== "removed") statusOf.set(transitionKey(t.item), t.status);
  const transitions: AnnotatedState["transitions"] = current.transitions
    .slice()
    .sort((a, b) => a.line - b.line)
    .map((t) => ({
      status: statusOf.get(transitionKey(t)) ?? "same",
      transition: t,
    }));
  const out = [...lines, "", "  %% kim: compare with the repo version"];
  for (const s of diff.states)
    if (s.status === "removed")
      out.push(
        s.item.label !== s.item.id
          ? `  state "${s.item.label.replace(/"/g, "'")}" as ${s.item.id}`
          : `  ${s.item.id}`,
      );
  const plain = (end: string) => (end.endsWith("/[*]") ? "[*]" : end);
  for (const t of diff.transitions) {
    if (t.status !== "removed") continue;
    // A start or end inside a composite can't be put back at the top level.
    if (
      (t.item.from.endsWith("/[*]") && t.item.from !== "/[*]") ||
      (t.item.to.endsWith("/[*]") && t.item.to !== "/[*]")
    )
      continue;
    out.push(
      `  ${plain(t.item.from)} --> ${plain(t.item.to)}${t.item.label ? ` : ${t.item.label}` : ""}`,
    );
    transitions.push({ status: "removed", transition: t.item });
  }
  const used = new Set<Exclude<Status, "same">>();
  for (const s of diff.states) {
    // Mermaid's classDef styles plain states, not composites.
    if (s.status === "same" || s.item.composite) continue;
    used.add(s.status);
  }
  for (const status of used) {
    out.push(`  ${classDef(status)}`);
    const ids = diff.states
      .filter((s) => s.status === status && !s.item.composite)
      .map((s) => s.item.id);
    out.push(`  class ${ids.join(",")} ${CLASS[status]}`);
  }
  return { source: `${out.join("\n")}\n`, transitions };
}

export const stateName = (s: State) => `${s.label} state`;
export function transitionName(
  t: Transition,
  labels: Map<string, string>,
): string {
  const end = (id: string) =>
    id.endsWith("[*]")
      ? id === t.from
        ? "start"
        : "end"
      : (labels.get(id) ?? id);
  return `${end(t.from)} → ${end(t.to)}${t.label ? `: ${t.label}` : ""} transition`;
}
