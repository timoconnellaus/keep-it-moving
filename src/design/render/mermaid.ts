import mermaid from "mermaid";
import {
  annotateSequence,
  diffSequence,
  messageName,
  parseSequence,
  participantName,
  type Message,
} from "../sequence.js";
import {
  annotateState,
  diffState,
  parseState,
  stateName,
  transitionName,
  type Transition,
} from "../state.js";
import {
  COLORS,
  noChanges,
  STATUS_COLORS,
  type ChangeCounts,
  type Status,
} from "../types.js";
import type { Prepare } from "./types.js";

/** Sequence and state diagrams through Mermaid, styled like the site. */

let ready = false;
function init() {
  if (ready) return;
  ready = true;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    // Mermaid 12 would otherwise pull in ELK (1.5 MB) for state diagrams.
    layout: "dagre",
    htmlLabels: false,
    fontFamily: "Figtree, system-ui, sans-serif",
    flowchart: { htmlLabels: false },
    sequence: {
      useMaxWidth: false,
      mirrorActors: true,
      actorFontFamily: "Figtree, system-ui, sans-serif",
      messageFontFamily: "Figtree, system-ui, sans-serif",
      noteFontFamily: "Figtree, system-ui, sans-serif",
    },
    state: { useMaxWidth: false },
    themeVariables: {
      fontFamily: "Figtree, system-ui, sans-serif",
      fontSize: "14px",
      background: "#ffffff",
      primaryColor: "#ffffff",
      primaryBorderColor: COLORS.lineStrong,
      primaryTextColor: COLORS.ink,
      secondaryColor: COLORS.panel,
      tertiaryColor: COLORS.canvas,
      lineColor: COLORS.muted,
      textColor: COLORS.ink,
      mainBkg: "#ffffff",
      nodeBorder: COLORS.lineStrong,
      clusterBkg: COLORS.panel,
      clusterBorder: COLORS.lineStrong,
      actorBkg: "#ffffff",
      actorBorder: COLORS.lineStrong,
      actorTextColor: COLORS.ink,
      actorLineColor: COLORS.faint,
      signalColor: COLORS.ink,
      signalTextColor: COLORS.ink,
      labelBoxBkgColor: COLORS.panel,
      labelBoxBorderColor: COLORS.lineStrong,
      labelTextColor: COLORS.ink,
      loopTextColor: COLORS.muted,
      noteBkgColor: "#fff3c4",
      noteBorderColor: "#ecd27a",
      noteTextColor: COLORS.ink,
      activationBkgColor: COLORS.blueSoft,
      activationBorderColor: COLORS.blue,
      sequenceNumberColor: "#ffffff",
      stateBkg: "#ffffff",
      stateLabelColor: COLORS.ink,
      transitionColor: COLORS.muted,
      transitionLabelColor: COLORS.muted,
      edgeLabelBackground: "#ffffff",
      compositeBackground: COLORS.panel,
      compositeTitleBackground: COLORS.panel,
      altBackground: COLORS.panel,
      specialStateColor: COLORS.ink,
      innerEndBackground: COLORS.ink,
    },
  });
}

let counter = 0;
async function renderSvg(source: string): Promise<string> {
  init();
  const { svg } = await mermaid.render(`kim-mermaid-${++counter}`, source);
  return naturalSize(svg);
}

/** Mermaid sizes to 100% with a max-width; give it its own size instead. */
function naturalSize(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const el = doc.documentElement;
  const box = el
    .getAttribute("viewBox")
    ?.split(/[\s,]+/)
    .map(Number);
  if (box && box.length === 4 && box.every(Number.isFinite)) {
    el.setAttribute("width", String(Math.ceil(box[2]!)));
    el.setAttribute("height", String(Math.ceil(box[3]!)));
    el.style.removeProperty("max-width");
    if (!el.getAttribute("style")) el.removeAttribute("style");
  }
  return new XMLSerializer().serializeToString(el);
}

/** Surfaces Mermaid's parse error before rendering, with its line. */
async function check(source: string) {
  init();
  await mermaid.parse(source);
}

function paint(el: Element | null, status: Status, fill = true) {
  if (!el || status === "same") return;
  const c = STATUS_COLORS[status];
  const e = el as SVGElement;
  if (fill) e.style.setProperty("fill", c.fill, "important");
  e.style.setProperty("stroke", c.stroke, "important");
  e.style.setProperty("stroke-width", "2px", "important");
  if (status === "removed")
    e.style.setProperty("stroke-dasharray", "5 4", "important");
}

// --- sequence ------------------------------------------------------------

function decorateSequence(
  root: HTMLElement,
  messages: { status: Status; message: Message }[],
  participants: Map<string, { name: string; status: Status }>,
  labels: Map<string, string>,
) {
  const texts = [...root.querySelectorAll(".messageText")];
  const lines = [
    ...root.querySelectorAll(
      '[data-et="message"], line[class^="messageLine"], path[class^="messageLine"]',
    ),
  ].filter((el, i, all) => all.indexOf(el) === i);
  messages.forEach(({ status, message }, i) => {
    const name = messageName(message, labels);
    for (const el of [texts[i], lines[i]]) {
      if (!el) continue;
      el.setAttribute("data-name", name);
      if (status !== "same" && el === lines[i]) {
        const c = STATUS_COLORS[status];
        (el as SVGElement).style.setProperty("stroke", c.stroke, "important");
      }
      if (status === "removed" && el === texts[i]) {
        (el as SVGElement).style.setProperty("fill", STATUS_COLORS.removed.ink);
        (el as SVGElement).style.setProperty("text-decoration", "line-through");
      }
    }
  });
  for (const [id, { name, status }] of participants) {
    const groups = root.querySelectorAll(
      `[data-et="participant"][data-id="${CSS.escape(id)}"], g[name="${CSS.escape(id)}"], rect.actor[name="${CSS.escape(id)}"]`,
    );
    for (const g of groups) {
      const target =
        g.tagName.toLowerCase() === "rect" ? (g.parentElement ?? g) : g;
      target.setAttribute("data-name", name);
      const box =
        g.tagName.toLowerCase() === "rect"
          ? g
          : g.querySelector("rect, circle");
      paint(box, status);
    }
  }
}

const prepareSequence: Prepare = async (source, base) => {
  await check(source);
  const model = parseSequence(source);
  const plainSvg = await renderSvg(source);
  const labels = new Map(model.participants.map((p) => [p.id, p.label]));
  const plainMessages = model.messages.map((message) => ({
    status: "same" as Status,
    message,
  }));
  const plainParticipants = new Map(
    model.participants.map((p) => [
      p.id,
      { name: participantName(p), status: "same" as Status },
    ]),
  );
  let compared: {
    svg: string;
    counts: ChangeCounts;
    messages: { status: Status; message: Message }[];
    participants: Map<string, { name: string; status: Status }>;
    labels: Map<string, string>;
  } | null = null;
  if (base !== null) {
    try {
      await check(base);
      const diff = diffSequence(parseSequence(base), model);
      const annotated = annotateSequence(model, diff);
      compared = {
        svg: await renderSvg(annotated.source),
        counts: diff.counts,
        messages: annotated.messages,
        participants: new Map(
          diff.participants.map((p) => [
            p.item.id,
            { name: participantName(p.item), status: p.status },
          ]),
        ),
        labels: new Map(
          diff.participants.map((p) => [p.item.id, p.item.label]),
        ),
      };
    } catch (error) {
      console.warn("kim: could not compare with the base", error);
    }
  }
  return {
    counts: compared?.counts ?? noChanges(),
    comparable: compared !== null,
    draw(root, compare) {
      if (compare && compared) {
        root.innerHTML = compared.svg;
        decorateSequence(
          root,
          compared.messages,
          compared.participants,
          compared.labels,
        );
      } else {
        root.innerHTML = plainSvg;
        decorateSequence(root, plainMessages, plainParticipants, labels);
      }
    },
    exportSvg: () => plainSvg,
  };
};

// --- state ---------------------------------------------------------------

function decorateState(
  root: HTMLElement,
  states: Map<string, { name: string; status: Status; composite: boolean }>,
  transitions: { status: Status; transition: Transition }[],
  labels: Map<string, string>,
) {
  const svg = root.querySelector("svg");
  const svgId = svg?.id ?? "";
  for (const node of root.querySelectorAll(
    "g.node[id], g.statediagram-cluster[id]",
  )) {
    const dataId = node.getAttribute("data-id");
    const m = new RegExp(
      `^${svgId.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}-state-(.+)-\\d+$`,
    ).exec(node.id);
    const id = dataId ?? m?.[1];
    const state = id ? states.get(id) : undefined;
    if (!state) continue;
    node.setAttribute("data-name", state.name);
    if (state.composite)
      paint(node.querySelector("rect.outer"), state.status, false);
  }
  const labelsById = new Map<string, Element>();
  for (const l of root.querySelectorAll("g.edgeLabels [data-id]"))
    labelsById.set(l.getAttribute("data-id")!, l);
  const edges = [
    ...root.querySelectorAll('path[data-et="edge"], path.transition'),
  ].filter((el, i, all) => all.indexOf(el) === i);
  edges.forEach((edge) => {
    const n = Number(
      /(\d+)$/.exec(edge.getAttribute("data-id") ?? edge.id)?.[1] ?? NaN,
    );
    const entry = Number.isFinite(n) ? transitions[n] : undefined;
    if (!entry) return;
    const name = transitionName(entry.transition, labels);
    edge.setAttribute("data-name", name);
    const label = labelsById.get(edge.getAttribute("data-id") ?? "");
    label?.closest("g.edgeLabel")?.setAttribute("data-name", name);
    if (entry.status !== "same") {
      const c = STATUS_COLORS[entry.status];
      const e = edge as SVGElement;
      e.style.setProperty("stroke", c.stroke, "important");
      e.style.setProperty("stroke-width", "2px", "important");
      if (entry.status === "removed")
        e.style.setProperty("stroke-dasharray", "5 4", "important");
      if (label)
        (label.querySelector("text") as SVGElement | null)?.style.setProperty(
          "fill",
          c.ink,
        );
    }
  });
}

const prepareState: Prepare = async (source, base) => {
  await check(source);
  const model = parseState(source);
  const plainSvg = await renderSvg(source);
  const labels = new Map(model.states.map((s) => [s.id, s.label]));
  const plainStates = new Map(
    model.states.map((s) => [
      s.id,
      { name: stateName(s), status: "same" as Status, composite: s.composite },
    ]),
  );
  const plainTransitions = [...model.transitions]
    .sort((a, b) => a.line - b.line)
    .map((transition) => ({ status: "same" as Status, transition }));
  let compared: {
    svg: string;
    counts: ChangeCounts;
    states: typeof plainStates;
    transitions: typeof plainTransitions;
    labels: Map<string, string>;
  } | null = null;
  if (base !== null) {
    try {
      await check(base);
      const diff = diffState(parseState(base), model);
      const annotated = annotateState(source, model, diff);
      compared = {
        svg: await renderSvg(annotated.source),
        counts: diff.counts,
        states: new Map(
          diff.states.map((s) => [
            s.item.id,
            {
              name: stateName(s.item),
              status: s.status,
              composite: s.item.composite,
            },
          ]),
        ),
        transitions: annotated.transitions,
        labels: new Map(diff.states.map((s) => [s.item.id, s.item.label])),
      };
    } catch (error) {
      console.warn("kim: could not compare with the base", error);
    }
  }
  return {
    counts: compared?.counts ?? noChanges(),
    comparable: compared !== null,
    draw(root, compare) {
      if (compare && compared) {
        root.innerHTML = compared.svg;
        decorateState(
          root,
          compared.states,
          compared.transitions,
          compared.labels,
        );
      } else {
        root.innerHTML = plainSvg;
        decorateState(root, plainStates, plainTransitions, labels);
      }
    },
    exportSvg: () => plainSvg,
  };
};

export const prepareMermaid = (kind: "sequence" | "state"): Prepare =>
  kind === "sequence" ? prepareSequence : prepareState;
