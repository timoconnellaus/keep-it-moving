import { D2 } from "@terrastruct/d2";
import {
  annotateD2,
  d2Links,
  d2Names,
  diffD2,
  graphFromDiagram,
  nameD2Svg,
  type D2Graph,
} from "../d2.js";
import { noChanges, type Status } from "../types.js";
import type { Prepare } from "./types.js";

/**
 * D2 through its wasm build. The browser build carries the wasm inside the
 * script and runs it in a Worker made from a blob, so nothing else is fetched.
 */

let instance: D2 | null = null;
const d2 = () => (instance ??= new D2());

/** The site's palette as D2 theme colours; appended so line numbers stay put. */
const THEME = `
vars: {
  d2-config: {
    theme-overrides: {
      N1: "#0e0f11"
      N2: "#676c74"
      N3: "#9aa0a9"
      N4: "#d3d7dd"
      N5: "#e4e6ea"
      N6: "#f6f6f7"
      N7: "#ffffff"
      B1: "#3a4150"
      B2: "#1f6bff"
      B3: "#cfdcff"
      B4: "#eef0f3"
      B5: "#e8f0ff"
      B6: "#ffffff"
      AA2: "#1f6bff"
      AA4: "#e8f0ff"
      AA5: "#f3f7ff"
      AB4: "#fff3c4"
      AB5: "#fff9e0"
    }
  }
}
`;

interface Compiled {
  diagram: Parameters<D2["render"]>[0];
  renderOptions: Record<string, unknown>;
}

async function compile(source: string): Promise<Compiled> {
  const result = await d2().compile({
    fs: { index: `${source.replace(/\s*$/, "")}\n${THEME}` },
    options: { layout: "dagre" },
  });
  return {
    diagram: result.diagram,
    renderOptions: result.renderOptions as Record<string, unknown>,
  };
}

async function render(compiled: Compiled): Promise<string> {
  const svg = await d2().render(compiled.diagram, {
    ...compiled.renderOptions,
    noXMLTag: true,
    pad: 24,
    scale: 1,
    center: false,
  });
  return svg;
}

export const prepare: Prepare = async (source, base) => {
  const current = await compile(source);
  const graph: D2Graph = graphFromDiagram(current.diagram as never);
  const plainSvg = await render(current);
  let compareSvg: string | null = null;
  let counts = noChanges();
  let names = d2Names(graph);
  const links = d2Links(graph, names);
  let statuses = new Map<string, Status>();
  if (base !== null) {
    try {
      const baseGraph = graphFromDiagram(
        (await compile(base)).diagram as never,
      );
      const diff = diffD2(baseGraph, graph);
      counts = diff.counts;
      const annotated = await compile(annotateD2(source, diff, graph));
      const annotatedGraph = graphFromDiagram(annotated.diagram as never);
      // Removed items are named from the base, the rest from the current.
      names = new Map([...d2Names(baseGraph), ...d2Names(annotatedGraph)]);
      statuses = new Map<string, Status>([
        ...diff.shapes,
        ...diff.connections,
        ...diff.removedShapes.map((s) => [s.id, "removed"] as const),
        ...diff.removedConnections.map((c) => [c.id, "removed"] as const),
      ]);
      compareSvg = await render(annotated);
    } catch (error) {
      console.warn("kim: could not compare with the base", error);
      compareSvg = null;
      counts = noChanges();
    }
  }
  return {
    counts,
    links,
    comparable: compareSvg !== null,
    draw(root, compare) {
      root.innerHTML =
        compare && compareSvg
          ? nameD2Svg(compareSvg, names, statuses)
          : nameD2Svg(plainSvg, names);
    },
    exportSvg: () => plainSvg,
  };
};
