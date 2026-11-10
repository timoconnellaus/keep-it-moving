import { describe, expect, it } from "vitest";
import { inspectDesign } from "../src/designCheck.js";
import {
  lineFindings,
  readability,
  sampleCurve,
} from "../src/design/layoutCheck.js";

const codes = (findings: Array<{ code: string }>) =>
  findings.map((f) => f.code);

describe("inspectDesign: syntax", () => {
  it("passes designs that draw, with nothing to say about small ones", async () => {
    const good = {
      "data-model": "Table users {\n  id int [pk]\n}\n",
      architecture: "web -> api: calls\napi -> db\n",
      "data-flow": "events -> warehouse -> dashboards\n",
      sequence: "sequenceDiagram\n  A->>B: hi\n",
      state: "stateDiagram-v2\n  [*] --> Draft\n  Draft --> Sent\n",
      api: "openapi: 3.0.0\ninfo: {title: T, version: '1'}\npaths:\n  /a:\n    get:\n      responses: {'200': {description: ok}}\n",
    } as const;
    for (const [type, source] of Object.entries(good))
      expect(
        await inspectDesign(type as keyof typeof good, source),
        type,
      ).toEqual({ errors: [], warnings: [] });
  }, 30_000);

  it("reports every DBML error at its own line, with the line's text", async () => {
    const { errors } = await inspectDesign(
      "data-model",
      "Table a {\n id int [pk\n}\nTable b {\n x int [\n}\n",
    );
    expect(errors.map((e) => [e.code, e.line, e.text])).toEqual([
      ["design/syntax", 3, "}"],
      ["design/syntax", 6, "}"],
    ]);
  });

  it("names the line of a D2 error", async () => {
    const { errors } = await inspectDesign("architecture", "a -> b\nc ->\n");
    expect(errors).toMatchObject([
      { code: "design/syntax", line: 2, text: "c ->" },
    ]);
    expect(errors[0]!.message).toContain("connection missing destination");
  }, 30_000);

  it("names the line of a Mermaid error", async () => {
    const { errors } = await inspectDesign(
      "sequence",
      "sequenceDiagram\n  A->>: hi\n",
    );
    expect(errors[0]).toMatchObject({ code: "design/syntax", line: 2 });
  });

  it("refuses a Mermaid diagram of the wrong kind", async () => {
    const { errors } = await inspectDesign(
      "sequence",
      "stateDiagram-v2\n  [*] --> A\n",
    );
    expect(errors[0]?.code).toBe("design/wrong-diagram");
    expect(errors[0]?.message).toContain("sequenceDiagram");
  });

  it("reports a YAML error in an API design", async () => {
    const { errors } = await inspectDesign("api", "openapi: 3.0.0\npaths: [\n");
    expect(errors).toHaveLength(1);
  });
});

describe("inspectDesign: layout", () => {
  it("names the D2 connections that cross", async () => {
    const source = ["a", "b", "c"]
      .flatMap((from) => ["x", "y", "z"].map((to) => `${from} -> ${to}`))
      .join("\n");
    const { warnings } = await inspectDesign("architecture", source);
    const crossings = warnings.filter((w) => w.code === "layout/crossing");
    expect(crossings.length).toBeGreaterThan(0);
    // Capped, with the rest counted.
    expect(crossings.length).toBeLessThanOrEqual(5);
    expect(crossings[0]!.subject).toHaveLength(2);
    expect(crossings[0]!.fixes.length).toBeGreaterThan(0);
  }, 30_000);

  it("warns when a D2 design must shrink too far to fit its frame", async () => {
    const source = Array.from(
      { length: 40 },
      (_, i) => `hub -> service${i}: calls`,
    ).join("\n");
    const { warnings } = await inspectDesign("architecture", source);
    const small = warnings.find((w) => w.code === "layout/text-too-small");
    expect(small?.evidence?.shownTextPx).toBeLessThan(7.5);
    expect(small?.fixes[0]).toContain("direction");
  }, 30_000);

  it("warns when a schema is too big to read in one frame", async () => {
    const source = Array.from(
      { length: 30 },
      (_, i) =>
        `Table t${i} {\n  id int [pk]\n  parent_id int [ref: > t${Math.max(0, i - 1)}.id]\n}`,
    ).join("\n");
    const { warnings } = await inspectDesign("data-model", source);
    expect(codes(warnings)).toEqual(["layout/text-too-small"]);
    expect(warnings[0]!.fixes.join(" ")).toContain("30 tables");
  });
});

describe("layout geometry", () => {
  const rules = {
    related: (line: { from: string; to: string }, box: { name: string }) =>
      box.name === line.from || box.name === line.to,
    shareEnd: (
      a: { from: string; to: string },
      b: { from: string; to: string },
    ) => [a.from, a.to].some((x) => [b.from, b.to].includes(x)),
    fixes: { crossing: ["c"], throughShape: ["t"], labelOverShape: ["l"] },
  };
  const box = (name: string, x: number, y: number) => ({
    name,
    x,
    y,
    w: 40,
    h: 40,
  });

  it("finds a crossing, but not where lines share an end", () => {
    const lines = [
      {
        name: "a -> b",
        from: "a",
        to: "b",
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
      },
      {
        name: "c -> d",
        from: "c",
        to: "d",
        points: [
          { x: 0, y: 100 },
          { x: 100, y: 0 },
        ],
      },
      {
        name: "a -> d",
        from: "a",
        to: "d",
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
    ];
    expect(lineFindings(lines, [], rules).map((f) => f.message)).toEqual([
      "a -> b crosses c -> d",
    ]);
  });

  it("finds a line through a shape it doesn't connect, and a label on one", () => {
    const lines = [
      {
        name: "a -> b",
        from: "a",
        to: "b",
        points: [
          { x: 0, y: 20 },
          { x: 200, y: 20 },
        ],
        label: { w: 30, h: 12 },
      },
    ];
    const boxes = [box("a", -40, 0), box("m", 80, 0), box("b", 200, 0)];
    expect(codes(lineFindings(lines, boxes, rules))).toEqual([
      "layout/line-through-shape",
      "layout/label-over-shape",
    ]);
  });

  it("never scales a design up, so a small one always reads", () => {
    expect(readability({ w: 300, h: 200 }, 6, [])).toBeNull();
    expect(readability({ w: 4000, h: 500 }, 16, [])?.code).toBe(
      "layout/text-too-small",
    );
  });

  it("samples a Bézier route through its end points", () => {
    const route = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 10 },
      { x: 30, y: 10 },
    ];
    const points = sampleCurve(route);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 30, y: 10 });
    expect(points.length).toBe(9);
  });
});
