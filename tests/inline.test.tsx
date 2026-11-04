/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { escapeBlocks, Inline, plainText } from "../src/web/inline.js";

afterEach(cleanup);

const html = (text: string, links?: boolean) =>
  render(
    <span>
      <Inline text={text} {...(links === undefined ? {} : { links })} />
    </span>,
  ).container.firstElementChild!.innerHTML;

describe("inline Markdown in prompts and options", () => {
  it("renders bold, italics, code, strikethrough and links", () => {
    expect(
      html(
        "Take every change that isn't marked **Decide**? (_Comment_ on `row`, ~~not~~ [docs](https://x.dev))",
      ),
    ).toBe(
      'Take every change that isn\'t marked <strong>Decide</strong>? (<em>Comment</em> on <code>row</code>, <del>not</del> <a href="https://x.dev" target="_blank" rel="noreferrer">docs</a>)',
    );
  });

  it("leaves a link as its text where it can't be one", () => {
    expect(html("See [docs](https://x.dev)", false)).toBe("See docs");
  });

  it("keeps what would start a block as text", () => {
    expect(html("1. First")).toBe("1. First");
    expect(html("- Item")).toBe("- Item");
    expect(html("# Not a heading")).toBe("# Not a heading");
    expect(html("> quoted")).toBe("&gt; quoted");
    expect(html("---")).toBe("---");
    expect(escapeBlocks("**bold** start")).toBe("**bold** start");
  });

  it("shows HTML the agent wrote as text, never as elements", () => {
    // Shown as the text it is, as prompts always were.
    expect(html("Pick <b>A</b><script>alert(1)</script>")).toBe(
      "Pick &lt;b&gt;A&lt;/b&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("gives labels and titles the words without the marks", () => {
    expect(plainText("Marked **Decide** or __later__, *maybe* `now`")).toBe(
      "Marked Decide or later, maybe now",
    );
    expect(plainText("[docs](https://x.dev) ~~old~~")).toBe("docs old");
    expect(plainText("snake_case_name and 2 * 3 * 4")).toBe(
      "snake_case_name and 2 * 3 * 4",
    );
  });
});
