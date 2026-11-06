import { describe, expect, it } from "vitest";
import { diffApi, parseApi } from "../src/design/api.js";
import { apiHtml, apiSvg } from "../src/design/apiView.js";
import { SAMPLES } from "../src/design/dev/samples.js";
import { describeError } from "../src/design/errors.js";

const sample = SAMPLES.api!;

describe("parseApi", () => {
  const model = parseApi(sample.source);

  it("lists one operation per method and path", () => {
    expect(model.title).toBe("Designs API");
    expect(model.operations.map((o) => `${o.method} ${o.path}`)).toEqual([
      "GET /api/sessions/{id}/designs",
      "POST /api/sessions/{id}/designs",
      "PATCH /api/sessions/{id}/designs/{designId}",
    ]);
  });

  it("shows parameters, the request body and each response compactly", () => {
    const post = model.operations[1]!;
    expect(post.summary).toBe("Pull a copy from the repo");
    expect(post.sections.map((s) => s.title)).toEqual([
      "Request",
      "201",
      "409",
    ]);
    expect(post.sections[0]!.lines).toEqual([
      "path id: string",
      "",
      "{",
      "  path: string  // .kim/designs/…",
      "  baseCommit: string",
      "  type: DesignType",
      "  source: string",
      "}",
    ]);
    expect(post.sections[2]!.lines).toContain('  code?: "already_pulled"');
  });

  it("opens a top-level $ref one level, under its name", () => {
    const api = parseApi(`openapi: 3.0.0
paths:
  /x:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Thing" }
components:
  schemas:
    Thing:
      type: object
      required: [id]
      properties:
        id: { type: string, format: uuid }
        parent: { $ref: "#/components/schemas/Thing" }
        tags: { type: array, items: { type: string } }
`);
    expect(api.operations[0]!.sections[1]!.lines).toEqual([
      "Thing {",
      "  id: string<uuid>",
      "  parent?: Thing",
      "  tags?: string[]",
      "}",
    ]);
  });

  it("explains a document without paths, and YAML errors with their place", () => {
    expect(() => parseApi("openapi: 3.0.0\ninfo: {}\n")).toThrow(/no `paths`/);
    let error: unknown;
    try {
      parseApi("paths:\n  /x:\n    get: [\n");
    } catch (e) {
      error = e;
    }
    const described = describeError(error);
    expect(described.line).toBeGreaterThan(0);
    expect(described.message).not.toContain("\n");
  });
});

describe("diffApi", () => {
  const diff = diffApi(parseApi(sample.base!), parseApi(sample.source));

  it("marks operations added, changed and removed", () => {
    expect(
      diff.operations.map((o) => `${o.operation.method} ${o.status}`),
    ).toEqual(["GET same", "POST added", "PATCH changed", "DELETE removed"]);
    expect(diff.counts).toEqual({ added: 1, changed: 1, removed: 1 });
  });

  it("marks the lines of a changed operation", () => {
    const patch = diff.operations[2]!;
    const response = patch.sections.find((s) => s.title === "200")!;
    expect(
      response.lines
        .filter((l) => l.status !== "same")
        .map((l) => `${l.status} ${l.item.trim()}`),
    ).toEqual(["removed diff?: string", "added changes?: Change[]"]);
    const request = patch.sections[0]!;
    expect(request.lines.find((l) => l.status === "added")?.item).toContain(
      "note?: string",
    );
  });

  it("names cards for pins and draws a plain SVG", () => {
    const model = parseApi(sample.source);
    const html = apiHtml(model, diff, true);
    expect(html).toContain('data-name="POST /api/sessions/{id}/designs"');
    expect(html).toContain('class="ep removed"');
    const svg = apiSvg(model);
    expect(svg).toContain(
      'data-name="PATCH /api/sessions/{id}/designs/{designId}"',
    );
    expect(svg).not.toContain("removed");
  });
});
