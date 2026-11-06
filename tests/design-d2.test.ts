import { describe, expect, it } from "vitest";
import {
  annotateD2,
  d2Names,
  decodeD2Class,
  diffD2,
  keyToSource,
  nameD2Svg,
  parseConnectionId,
  splitKey,
  type D2Graph,
} from "../src/design/d2.js";

const shape = (id: string, label = id, sig = "") => ({
  id,
  label,
  type: "rectangle",
  signature: `${label}${sig}`,
});
const edge = (id: string, src: string, dst: string, label = "") => ({
  id,
  src,
  dst,
  label,
  signature: `${src}>${dst}:${label}`,
});

// Shapes and connections as the d2 compiler names them.
const base: D2Graph = {
  shapes: [
    shape("api service", "API"),
    shape("db", "Postgres"),
    shape("cloud"),
    shape("cloud.w", "Worker"),
    shape("cache"),
  ],
  connections: [
    edge("(api service -> db)[0]", "api service", "db", "reads"),
    edge("(api service -> db)[1]", "api service", "db", "writes"),
    edge("cloud.(w -> q)[0]", "cloud.w", "cloud.q", "enqueue"),
    edge("(api service -> cache)[0]", "api service", "cache"),
  ],
};
const current: D2Graph = {
  shapes: [
    shape("api service", "API"),
    shape("db", "Postgres 16"),
    shape("cloud"),
    shape("cloud.w", "Worker"),
    shape("queue"),
  ],
  connections: [
    edge("(api service -> db)[0]", "api service", "db", "writes"),
    edge("cloud.(w -> q)[0]", "cloud.w", "cloud.q", "publishes"),
    edge("(api service -> queue)[0]", "api service", "queue"),
  ],
};

describe("d2 keys", () => {
  it("splits on dots outside quotes and quotes what needs it", () => {
    expect(splitKey('a."b.c".d')).toEqual(["a", '"b.c"', "d"]);
    expect(keyToSource("api service.w")).toBe('"api service".w');
    expect(keyToSource('"a.b"')).toBe('"a.b"');
  });
  it("reads connection ids", () => {
    expect(parseConnectionId("cloud.(w -> q)[2]")).toEqual({
      scope: "cloud",
      src: "w",
      arrow: "->",
      dst: "q",
      index: 2,
    });
    expect(parseConnectionId("(api service <-> db)[0]")).toMatchObject({
      scope: "",
      src: "api service",
      arrow: "<->",
    });
  });
});

describe("diffD2", () => {
  const diff = diffD2(base, current);
  it("compares shapes by id", () => {
    expect(diff.shapes.get("api service")).toBe("same");
    expect(diff.shapes.get("db")).toBe("changed");
    expect(diff.shapes.get("queue")).toBe("added");
    expect(diff.removedShapes.map((s) => s.id)).toEqual(["cache"]);
  });
  it("matches parallel connections by content before position", () => {
    // "reads" went, "writes" stayed though it moved from [1] to [0].
    expect(diff.connections.get("(api service -> db)[0]")).toBe("same");
    expect(diff.removedConnections.map((c) => c.label)).toEqual(["reads", ""]);
    expect(diff.connections.get("cloud.(w -> q)[0]")).toBe("changed");
    expect(diff.connections.get("(api service -> queue)[0]")).toBe("added");
    expect(diff.counts).toEqual({ added: 2, changed: 2, removed: 3 });
  });
});

describe("annotateD2", () => {
  const source = '"api service": API\ndb: Postgres 16\n';
  const out = annotateD2(source, diffD2(base, current), current);
  it("keeps the source first, so its line numbers hold", () => {
    expect(out.startsWith(source.trimEnd())).toBe(true);
  });
  it("styles changed and added shapes and connections", () => {
    expect(out).toContain('db.style.fill: "#fff1d6"');
    expect(out).toContain('queue.style.stroke: "#2fbf71"');
    expect(out).toContain('cloud.(w -> q)[0].style.stroke: "#d98a00"');
    expect(out).toContain(
      '("api service" -> queue)[0].style.stroke: "#2fbf71"',
    );
  });
  it("puts removed shapes and connections back, dashed", () => {
    expect(out).toContain('cache: "cache"');
    expect(out).toContain("cache.style.stroke-dash: 4");
    expect(out).toContain('"api service" -> db: "reads"');
    // The re-added edge takes the next index in its group.
    expect(out).toContain('("api service" -> db)[1].style.stroke-dash: 4');
    expect(out).toContain(
      '("api service" -> cache)[0].style.stroke: "#d64545"',
    );
  });
});

describe("naming d2 SVGs", () => {
  it("decodes d2's base64 class names, HTML-escaped ids included", () => {
    expect(decodeD2Class("YXBpIHNlcnZpY2U=")).toBe("api service");
    expect(decodeD2Class("Y2xvdWQuKHcgLSZndDsgcSlbMF0=")).toBe(
      "cloud.(w -> q)[0]",
    );
    expect(decodeD2Class("shape")).toBeNull();
  });
  it("adds data-name to shapes and connections", () => {
    const svg =
      '<g class="YXBpIHNlcnZpY2U="><rect/></g><g class="Y2xvdWQuKHcgLSZndDsgcSlbMF0="></g><g class="shape"></g>';
    const named = nameD2Svg(svg, d2Names(current));
    expect(named).toContain('<g class="YXBpIHNlcnZpY2U=" data-name="API">');
    expect(named).toContain('data-name="Worker → q: publishes"');
    expect(named).toContain('<g class="shape">');
  });
});
