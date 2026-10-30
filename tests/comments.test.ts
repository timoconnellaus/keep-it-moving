// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMENTS_SOURCE, renderArtifact } from "../src/server/artifactView.js";

const PAGE = `
<header data-name="store header"><a href="#">Field &amp; Ink</a></header>
<main>
  <h1>Checkout</h1>
  <form>
    <label>Email <input id="email" placeholder="you@example.com"></label>
    <div class="row"><button type="button"><span>Pay $48.00</span></button></div>
  </form>
</main>`;

describe("the comments script", () => {
  // Each script gets a frame of its own, as on the page.
  let frame: Window;
  let sent: unknown[];
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const start = () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    frame = iframe.contentWindow!;
    frame.document.body.innerHTML = PAGE;
    sent = [];
    vi.spyOn(frame.parent, "postMessage").mockImplementation(
      (message: unknown) => {
        sent.push(message);
      },
    );
    (new Function(`return ${COMMENTS_SOURCE}`)() as (win: Window) => void)(
      frame,
    );
  };
  const $ = (selector: string) => frame.document.querySelector(selector)!;
  /** jsdom has no layout: the point lands on `target`, inside a 100×40 box at (20, 10). */
  const pointAt = (target: Element) => {
    frame.document.elementFromPoint = () => target;
    for (const el of frame.document.querySelectorAll("*"))
      el.getBoundingClientRect = () =>
        ({ left: 20, top: 10, width: 100, height: 40 }) as DOMRect;
  };
  const pick = (x = 70, y = 20, source: unknown = frame.parent) =>
    frame.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "kim-pick", req: "r1", x, y },
        source: source as Window,
      }),
    );

  it("names an element by its data-name", () => {
    start();
    pointAt($("header a"));
    pick();
    expect(sent).toEqual([
      {
        type: "kim-picked",
        req: "r1",
        element: "store header",
        selector: null,
        fx: 0.5,
        fy: 0.25,
        x: 70,
        y: 20,
        width: expect.any(Number) as number,
      },
    ]);
  });

  it("describes an unnamed element by its text, with a selector that finds it again", () => {
    start();
    const span = $("button span");
    pointAt(span);
    pick();
    const [reply] = sent as Array<{ element: string; selector: string }>;
    expect(reply!.element).toBe('button "Pay $48.00"');
    expect(frame.document.querySelector(reply!.selector)).toBe($("button"));
  });

  it("describes a field by its label, and starts its selector from an id", () => {
    start();
    pointAt($("#email"));
    pick();
    const [reply] = sent as Array<{ element: string; selector: string }>;
    expect(reply!.element).toBe('input "you@example.com"');
    expect(reply!.selector).toBe("#email");
  });

  it("calls a point on no element the page", () => {
    start();
    pointAt(frame.document.body);
    pick();
    expect(sent).toMatchObject([{ element: "page", selector: "body" }]);
  });

  it("outlines the element for a moment", () => {
    vi.useFakeTimers();
    start();
    pointAt($("h1"));
    pick();
    const outline = () =>
      [...frame.document.documentElement.querySelectorAll("div")].filter(
        (div) => div.style.border.includes("3px"),
      );
    expect(outline()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(outline()).toHaveLength(0);
    vi.useRealTimers();
  });

  it("answers only the page framing it", () => {
    start();
    pointAt($("h1"));
    pick(70, 20, frame);
    expect(sent).toEqual([]);
  });

  it("draws pins on their elements, outside the page's own markup", () => {
    start();
    pointAt($("h1"));
    frame.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "kim-pins",
          pins: [
            {
              n: 1,
              element: "store header",
              selector: null,
              fx: 0.5,
              fy: 0,
              x: 0,
              y: 0,
            },
            {
              n: 2,
              element: 'button "Pay"',
              selector: "#missing",
              fx: 0,
              fy: 0,
              x: 5,
              y: 600,
            },
          ],
        },
        source: frame.parent,
      }),
    );
    const marks = [
      ...frame.document.documentElement.querySelectorAll("span"),
    ].filter((span) => span.style.borderRadius);
    expect(marks.map((mark) => mark.textContent)).toEqual(["1", "2"]);
    // On its element's box; one whose element is gone keeps its point.
    expect([marks[0]!.style.left, marks[0]!.style.top]).toEqual([
      "70px",
      "10px",
    ]);
    expect([marks[1]!.style.left, marks[1]!.style.top]).toEqual([
      "5px",
      "600px",
    ]);
    expect(frame.document.body.innerHTML.trim()).toBe(PAGE.trim());
  });

  it("passes Esc up, even with focus in the frame", () => {
    start();
    ($("#email") as HTMLInputElement).focus();
    $("#email").dispatchEvent(
      new frame.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    $("#email").dispatchEvent(
      new frame.KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    expect(sent).toEqual([{ type: "kim-key", key: "Escape" }]);
  });

  it("is served in every html artifact", () => {
    expect(renderArtifact("<html><head></head></html>", {})).toContain(
      `${COMMENTS_SOURCE}(window);`,
    );
  });
});
