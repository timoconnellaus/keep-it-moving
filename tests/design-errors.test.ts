import { describe, expect, it } from "vitest";
import { errorHtml } from "../src/design/errorView.js";
import {
  describeError,
  DesignParseError,
  placeLabel,
  sourceLines,
} from "../src/design/errors.js";

describe("describeError", () => {
  it("reads our own errors", () => {
    expect(describeError(new DesignParseError("bad", 2, 3))).toEqual({
      message: "bad",
      line: 2,
      column: 3,
    });
  });
  it("reads @dbml/core diags", () => {
    expect(
      describeError({
        diags: [
          {
            message: "Expect an identifier",
            location: { start: { line: 3, column: 1 } },
          },
        ],
      }),
    ).toEqual({ message: "Expect an identifier", line: 3, column: 1 });
  });
  it("reads yaml's linePos", () => {
    const error = Object.assign(
      new Error(
        "Nested mappings are not allowed at line 2, column 5:\n\n  a: b: c\n",
      ),
      {
        linePos: [{ line: 2, col: 5 }],
      },
    );
    expect(describeError(error)).toEqual({
      message: "Nested mappings are not allowed",
      line: 2,
      column: 5,
    });
  });
  it("reads Mermaid's parse errors", () => {
    const error = Object.assign(
      new Error(
        "Parse error on line 4:\n...>B: hi\n-----^\nExpecting 'ACTOR', 'TXT', got 'NEWLINE'",
      ),
      { hash: { loc: { first_line: 4, first_column: 2 } } },
    );
    expect(describeError(error)).toEqual({
      message: "Unexpected newline; expected actor, txt",
      line: 4,
      column: 3,
    });
    expect(
      describeError(
        new Error("Parse error on line 7:\nx\n^\nExpecting 'A', got 'B'"),
      ).line,
    ).toBe(7);
  });
  it("reads D2's errors", () => {
    const message = JSON.stringify([
      {
        range: "index,0:0:0-0:5:5",
        errmsg: "index:1:1: connection missing destination",
      },
      {
        range: "index,0:5:5-1:2:9",
        errmsg: "index:1:6: maps must be terminated with }",
      },
    ]);
    expect(describeError(new Error(message))).toEqual({
      message: "connection missing destination\nmaps must be terminated with }",
      line: 1,
      column: 1,
    });
  });
  it("falls back to the message", () => {
    expect(describeError("nope")).toEqual({
      message: "nope",
      line: null,
      column: null,
    });
  });
});

describe("error view", () => {
  it("numbers the source and marks the bad line", () => {
    expect(sourceLines("a\nb\nc\n", 2)).toEqual([
      { number: 1, text: "a", bad: false },
      { number: 2, text: "b", bad: true },
      { number: 3, text: "c", bad: false },
    ]);
    expect(placeLabel({ message: "", line: 2, column: null })).toBe("Line 2");
  });
  it("escapes the source", () => {
    const html = errorHtml("data model", "Table <x> {\n", {
      message: "bad <thing>",
      line: 1,
      column: 7,
    });
    expect(html).toContain("Line 1, column 7");
    expect(html).toContain("bad &lt;thing&gt;");
    expect(html).toContain(
      '<span class="ln bad" id="kim-bad-line"><b>1</b>Table &lt;x&gt; {</span>',
    );
  });
});
