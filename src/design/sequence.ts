import { align, matchByKey, type Merged } from "./align.js";
import { count, noChanges, type ChangeCounts, type Status } from "./types.js";

/**
 * Mermaid sequence diagrams, read line by line: enough to compare the
 * participants and messages and to annotate a copy of the source. Mermaid
 * itself still parses and draws the result.
 */

export interface Participant {
  id: string;
  label: string;
  kind: "participant" | "actor";
  explicit: boolean;
}

export interface Message {
  from: string;
  to: string;
  arrow: string;
  text: string;
  /** 0-based line in the source. */
  line: number;
}

export interface SequenceModel {
  participants: Participant[];
  messages: Message[];
  lines: string[];
}

// Longest first, so `-->>` is not read as `-->` then `>`.
const ARROWS = [
  "<<-->>",
  "<<->>",
  "-->>",
  "->>",
  "-->",
  "->",
  "--x",
  "-x",
  "--)",
  "-)",
].map((a) => a.replace(/[()]/g, "\\$&"));
const ACTOR = "[^\\s+<>:,;][^+<>:,;]*?";
const MESSAGE = new RegExp(
  `^(${ACTOR})\\s*(${ARROWS.join("|")})\\s*([+-]?)\\s*(${ACTOR})\\s*(?::(.*))?$`,
);
const PARTICIPANT =
  /^(?:create\s+)?(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i;

/** Participant ids may carry a `@{ ... }` config block; drop it. */
const cleanId = (id: string) => id.replace(/@\{.*\}$/, "").trim();

export function parseSequence(source: string): SequenceModel {
  const lines = source.split("\n");
  const participants = new Map<string, Participant>();
  const messages: Message[] = [];
  const see = (id: string) => {
    if (!participants.has(id))
      participants.set(id, {
        id,
        label: id,
        kind: "participant",
        explicit: false,
      });
  };
  lines.forEach((raw, line) => {
    const text = raw.trim();
    if (!text || text.startsWith("%%")) return;
    const p = PARTICIPANT.exec(text);
    if (p) {
      const id = cleanId(p[2]!);
      participants.set(id, {
        id,
        label: (p[3] ?? id).trim(),
        kind: p[1]!.toLowerCase() as Participant["kind"],
        explicit: true,
      });
      return;
    }
    if (
      /^(note|loop|alt|else|opt|par|and|critical|option|break|rect|box|end|activate|deactivate|autonumber|title|destroy|links?|properties|details)\b/i.test(
        text,
      )
    )
      return;
    const m = MESSAGE.exec(text);
    if (m) {
      const from = m[1]!.trim();
      const to = m[4]!.trim();
      see(from);
      see(to);
      messages.push({
        from,
        to,
        arrow: m[2]!,
        text: (m[5] ?? "").trim(),
        line,
      });
    }
  });
  return { participants: [...participants.values()], messages, lines };
}

export interface SequenceDiff {
  participants: Merged<Participant>[];
  messages: Merged<Message>[];
  counts: ChangeCounts;
}

const messageKey = (m: Message) => `${m.from}\u0000${m.to}\u0000${m.text}`;

/**
 * Participants match by id (a new label is a change). Messages are lined
 * up in order; a message between the same two participants whose text or
 * arrow changed in the same spot reads as changed.
 */
export function diffSequence(
  base: SequenceModel,
  current: SequenceModel,
): SequenceDiff {
  const counts = noChanges();
  const participants = matchByKey(
    base.participants,
    current.participants,
    (p) => p.id,
    (a, b) => a.label === b.label && a.kind === b.kind,
  );
  const messages = align(base.messages, current.messages, messageKey, {
    group: (m) => `${m.from}\u0000${m.to}`,
    same: (a, b) => a.arrow === b.arrow,
  });
  for (const e of [...participants, ...messages]) count(counts, e.status);
  return { participants, messages, counts };
}

const RECT: Record<Exclude<Status, "same">, string> = {
  added: "rect rgb(227, 247, 236)",
  changed: "rect rgb(255, 241, 214)",
  removed: "rect rgb(253, 232, 232)",
};

/** A removed message is drawn dotted, without its activation. */
const dotted = (arrow: string) =>
  arrow.startsWith("--") || arrow.startsWith("<<--")
    ? arrow
    : arrow.startsWith("<<")
      ? `<<--${arrow.slice(3)}`
      : `-${arrow}`;

export interface AnnotatedSequence {
  source: string;
  /** The status of each message in the annotated source, in order. */
  messages: { status: Status; message: Message }[];
}

/**
 * A copy of the current source that shows the comparison: added and changed
 * messages sit in green and amber `rect` blocks, and removed messages are put
 * back where they were, dotted, in red blocks. Participants are coloured
 * afterwards in the SVG (see styleSequenceSvg).
 */
export function annotateSequence(
  current: SequenceModel,
  diff: SequenceDiff,
): AnnotatedSequence {
  const statusByLine = new Map<number, Status>();
  // Removed messages, keyed by the current line they come before (-1: at the end).
  const removedBefore = new Map<number, Message[]>();
  let pending: Message[] = [];
  for (const e of diff.messages) {
    if (e.status === "removed") {
      pending.push(e.item);
      continue;
    }
    statusByLine.set(e.item.line, e.status);
    if (pending.length) {
      removedBefore.set(e.item.line, pending);
      pending = [];
    }
  }
  const declared = new Set(
    current.participants.filter((p) => p.explicit).map((p) => p.id),
  );
  const removedParticipants = diff.participants
    .filter((p) => p.status === "removed")
    .map((p) => p.item);
  const declare = (ids: string[]) => {
    const out: string[] = [];
    for (const id of ids) {
      const p = removedParticipants.find((r) => r.id === id);
      if (p && !declared.has(id)) {
        declared.add(id);
        out.push(
          `${p.kind} ${p.id}${p.label !== p.id ? ` as ${p.label}` : ""}`,
        );
      }
    }
    return out;
  };
  const removedLines = (messages: Message[], indent: string) => [
    ...declare(messages.flatMap((m) => [m.from, m.to])),
    `${indent}${RECT.removed}`,
    ...messages.map(
      (m) => `${indent}  ${m.from}${dotted(m.arrow)}${m.to}: ${m.text}`,
    ),
    `${indent}end`,
  ];
  const out: string[] = [];
  const order: AnnotatedSequence["messages"] = [];
  const byLine = new Map(current.messages.map((m) => [m.line, m]));
  current.lines.forEach((raw, line) => {
    const indent = /^\s*/.exec(raw)![0];
    const before = removedBefore.get(line);
    if (before) {
      out.push(...removedLines(before, indent));
      for (const m of before) order.push({ status: "removed", message: m });
    }
    const status = statusByLine.get(line);
    const message = byLine.get(line);
    if (message && status && status !== "same") {
      out.push(`${indent}${RECT[status]}`, raw, `${indent}end`);
    } else out.push(raw);
    if (message) order.push({ status: status ?? "same", message });
  });
  if (pending.length) {
    out.push(...removedLines(pending, "  "));
    for (const m of pending) order.push({ status: "removed", message: m });
  }
  // Removed participants with no messages left still get drawn.
  const rest = declare(removedParticipants.map((p) => p.id));
  if (rest.length) out.push(...rest.map((l) => `  ${l}`));
  return { source: out.join("\n"), messages: order };
}

export const participantName = (p: Participant) => `${p.label} ${p.kind}`;
export function messageName(m: Message, labels: Map<string, string>): string {
  const from = labels.get(m.from) ?? m.from;
  const to = labels.get(m.to) ?? m.to;
  return `${from} → ${to}${m.text ? `: ${m.text}` : ""} message`;
}
