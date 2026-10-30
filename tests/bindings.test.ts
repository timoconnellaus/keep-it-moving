// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { APPLIER_SOURCE, renderArtifact } from "../src/server/artifactView.js";
import {
  answerValues,
  artifactValues,
  declaresControl,
  missingControls,
  type ControlValues,
} from "../src/shared/bindings.js";
import type { QuestionView } from "../src/shared/schema.js";

const question = (overrides: Partial<QuestionView>): QuestionView => ({
  id: "q",
  type: "single-choice",
  prompt: "Font?",
  recommendation: null,
  default: null,
  options: [],
  min: null,
  max: null,
  step: null,
  position: 0,
  artifactId: "a",
  optionArtifacts: {},
  optionValues: {},
  control: null,
  unit: null,
  answer: null,
  ...overrides,
});
const answered = (text: string, skipped = false) => ({
  text,
  skipped,
  revision: 1,
  delivered: false,
  updatedAt: "2026-10-30T00:00:00.000Z",
  answeredBy: null,
});

const MOCKUP = `<!doctype html>
<html data-kim-nav="side">
<head><style>
  :root { --font-display: "Inter", sans-serif; }
  h1 { font-family: var(--font-display); color: var(--accent, #1f6bff); }
  [data-kim-nav="top"] aside { display: none; }
</style></head>
<body><h1 data-kim-text="headline">Plan &amp; ship</h1><p data-kim-text='tagline'>Fast</p></body>
</html>`;

describe("declared controls", () => {
  it("finds variables defined or read, root attributes, and text slots", () => {
    expect(
      ["--font-display", "--accent", "@nav", "#headline", "#tagline"].filter(
        (control) => declaresControl(MOCKUP, control),
      ),
    ).toHaveLength(5);
    expect(
      missingControls(MOCKUP, ["--font", "--radius", "@theme", "#head"]),
    ).toEqual(["--font", "--radius", "@theme", "#head"]);
  });
});

describe("answer values", () => {
  const font = question({
    type: "multiple-choice",
    options: ["Serif", "Bold"],
    optionValues: {
      Serif: { "--font-display": "Fraunces" },
      Bold: { "--weight": "700", "--font-display": "Space Grotesk" },
    },
  });

  it("merges chosen options in option order and ignores a note", () => {
    expect(answerValues(font, "Serif, Bold — a bit heavier")).toEqual({
      "--font-display": "Space Grotesk",
      "--weight": "700",
    });
    expect(answerValues(font, "something else")).toBeNull();
  });

  it("appends a number's unit, and takes text as it is", () => {
    const radius = question({
      type: "number",
      control: "--radius",
      unit: "px",
    });
    expect(answerValues(radius, "12.5 — rounder")).toEqual({
      "--radius": "12.5px",
    });
    expect(answerValues(radius, "rounder")).toBeNull();
    const headline = question({ type: "text", control: "#headline" });
    expect(answerValues(headline, "  Ship it  ")).toEqual({
      "#headline": "Ship it",
    });
  });

  it("builds an artifact's state from saved answers, with previews on top", () => {
    const questions = [
      question({
        id: "1",
        options: ["Serif"],
        optionValues: font.optionValues,
        answer: answered("Serif"),
      }),
      question({
        id: "2",
        type: "text",
        control: "#headline",
        answer: answered("", true),
      }),
      question({ id: "3", artifactId: "other", type: "text", control: "#x" }),
    ];
    expect(artifactValues(questions, "a")).toEqual({
      "--font-display": "Fraunces",
    });
    expect(
      artifactValues(questions, "a", { "2": { "#headline": "Hi" } }),
    ).toEqual({ "--font-display": "Fraunces", "#headline": "Hi" });
  });
});

describe("served artifacts", () => {
  it("writes saved text into its slots and the applier into the head", () => {
    const served = renderArtifact(MOCKUP, {
      "#headline": "Less <work>",
      "--accent": "#e4572e",
    });
    expect(served).toContain(
      '<h1 data-kim-text="headline">Less &lt;work&gt;</h1>',
    );
    expect(served.startsWith("<!doctype html>\n<html")).toBe(true);
    const head = served.indexOf("<head>") + "<head>".length;
    expect(served.slice(head, head + 30)).toMatch(/^<script>\(function/);
    // The saved state travels as JSON that can't close the script early.
    expect(served).toContain('"#headline":"Less \\u003cwork>"');
    expect(served).toContain('"originals":{"#headline":"Plan & ship"}');
  });

  it("puts the applier first in a fragment without a head", () => {
    expect(renderArtifact("<main>Hi</main>", {})).toMatch(
      /^<script>[\s\S]*<\/script><main>Hi<\/main>$/,
    );
  });
});

describe("the applier", () => {
  // Each applier gets a frame of its own, as on the page.
  let frame: Window;
  afterEach(() => document.body.replaceChildren());

  const start = (values: ControlValues, originals: ControlValues = {}) => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    frame = iframe.contentWindow!;
    frame.document.body.innerHTML =
      '<h1 data-kim-text="headline">Plan</h1><h2 data-kim-text="headline">Plan</h2>';
    frame.document.documentElement.setAttribute("data-kim-nav", "side");
    (
      new Function(`return ${APPLIER_SOURCE}`)() as (
        win: Window,
        initial: unknown,
      ) => void
    )(frame, { values, originals });
  };
  const send = (values: unknown, source: unknown = frame.parent) =>
    frame.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "kim-set", values },
        source: source as Window,
      }),
    );
  const root = () => frame.document.documentElement;
  const texts = () =>
    [...frame.document.querySelectorAll("[data-kim-text]")].map(
      (slot) => slot.textContent,
    );

  it("applies the saved values straight away", () => {
    start({ "--accent": "#e4572e", "@nav": "top" });
    expect(root().style.getPropertyValue("--accent")).toBe("#e4572e");
    expect(root().getAttribute("data-kim-nav")).toBe("top");
  });

  it("follows the parent's messages, and restores what a message leaves out", () => {
    start({});
    send({ "--accent": "red", "@nav": "top", "#headline": "Ship" });
    expect(root().style.getPropertyValue("--accent")).toBe("red");
    expect(root().getAttribute("data-kim-nav")).toBe("top");
    expect(texts()).toEqual(["Ship", "Ship"]);

    send({ "--accent": "blue" });
    expect(root().style.getPropertyValue("--accent")).toBe("blue");
    expect(root().getAttribute("data-kim-nav")).toBe("side");
    expect(texts()).toEqual(["Plan", "Plan"]);
    send({});
    expect(root().style.getPropertyValue("--accent")).toBe("");
  });

  it("restores a text slot the server filled to the artifact's own text", () => {
    start({ "#headline": "Saved" }, { "#headline": "Original" });
    send({});
    expect(texts()).toEqual(["Original", "Original"]);
  });

  it("ignores messages from anything but its parent, and bad controls", () => {
    start({});
    send({ "--accent": "red" }, frame);
    send({ "not a control": "x", "--ok": 5 });
    expect(root().getAttribute("style")).toBeNull();
  });

  it("loads a font variable's family from Google Fonts once", () => {
    start({ "--font-display": '"Space Grotesk", sans-serif' });
    send({ "--font-display": '"Space Grotesk", sans-serif', "--accent": "x" });
    send({ "--font-body": "system-ui" });
    const links = [...frame.document.head.querySelectorAll("link")].map(
      (link) => link.href,
    );
    expect(links).toEqual([
      "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap",
    ]);
  });
});
