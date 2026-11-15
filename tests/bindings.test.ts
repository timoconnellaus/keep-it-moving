// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPLIER_SOURCE, renderArtifact } from "../src/server/artifactView.js";
import {
  answerValues,
  artifactValues,
  controlWarnings,
  datasetName,
  declaresControl,
  markupControls,
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

  it("counts an attribute a script reads through dataset", () => {
    expect(datasetName("@main-nav")).toBe("kimMainNav");
    const page = `<script>render(document.documentElement.dataset.kimMainNav)</script>`;
    expect(declaresControl(page, "@main-nav")).toBe(true);
    expect(declaresControl(page, "@main")).toBe(false);
  });

  it("lists the attributes and text slots the markup names", () => {
    expect(markupControls(MOCKUP)).toEqual(["@nav", "#headline", "#tagline"]);
  });
});

describe("control warnings", () => {
  const warn = (html: string, controls: string[]) =>
    controlWarnings(html, controls);

  it("has nothing to say about a mockup that works", () => {
    expect(
      warn(MOCKUP, ["--font-display", "--accent", "@nav", "#headline"]),
    ).toEqual([]);
  });

  it("accepts an attribute on <body> that a script there follows", () => {
    // The mockup from the bug report: kim writes a declared host too now.
    const page = `<html><body data-kim-example="software"><main></main><script>
      const render = () => { main.textContent = document.body.dataset.kimExample };
      new MutationObserver(render).observe(document.body, { attributeFilter: ["data-kim-example"] });
      render();
    </script></body></html>`;
    expect(warn(page, ["@example"])).toEqual([]);
  });

  it("warns when nothing reads an attribute", () => {
    expect(
      warn(`<html data-kim-density="cozy"><body></body></html>`, ["@density"]),
    ).toEqual([
      expect.stringMatching(
        /^@density: kim sets data-kim-density on <html>, but no CSS selector or script reads it/,
      ),
    ]);
  });

  it("warns when a script reads an attribute from <body> that only <html> gets", () => {
    const page = `<html><body><script>
      addEventListener("kim-change", () => draw(document.body.dataset.kimExample));
    </script></body></html>`;
    expect(warn(page, ["@example"])).toEqual([
      expect.stringContaining(
        "Read document.documentElement.dataset.kimExample",
      ),
    ]);
  });

  it("warns when only a script reads an attribute and nothing re-runs it", () => {
    const page = `<html><body><script>draw(document.documentElement.dataset.kimExample)</script></body></html>`;
    expect(warn(page, ["@example"])).toEqual([
      expect.stringContaining('window.addEventListener("kim-change", render)'),
    ]);
    expect(
      warn(page.replace("draw(", 'addEventListener("kim-change", x);draw('), [
        "@example",
      ]),
    ).toEqual([]);
  });

  it("warns about CSS that ties the attribute to an element without it", () => {
    const css = `<style>body[data-kim-nav="top"] aside { display: none }</style>`;
    expect(
      warn(`<html><head>${css}</head><body></body></html>`, ["@nav"]),
    ).toEqual([
      expect.stringContaining(
        "body[data-kim-nav…] needs that element to carry",
      ),
    ]);
    expect(
      warn(
        `<html><head>${css}</head><body data-kim-nav="side"></body></html>`,
        ["@nav"],
      ),
    ).toEqual([]);
    expect(
      warn(
        `<style>:root[data-kim-nav="top"] aside, html[data-kim-nav="top"] nav { display: none }</style>`,
        ["@nav"],
      ),
    ).toEqual([]);
  });

  it("warns when a declaration below :root shadows a variable", () => {
    expect(
      warn(`<style>body { --accent: red } a { color: var(--accent) }</style>`, [
        "--accent",
      ]),
    ).toEqual([expect.stringContaining('also declared in "body"')]);
    expect(
      warn(`<style>.card { --accent: red; color: var(--accent) }</style>`, [
        "--accent",
      ]),
    ).toEqual([expect.stringContaining('also declared in ".card"')]);
    expect(
      warn(`<p style="--accent: red; color: var(--accent)">Hi</p>`, [
        "--accent",
      ]),
    ).toEqual([expect.stringContaining('"<p style>"')]);
    // A default on :root with a deliberate override lower down is fine.
    expect(
      warn(
        `<style>/* x */ :root { --accent: red } @media (prefers-color-scheme: dark) { :root { --accent: pink } } .dark { --accent: white }</style>`,
        ["--accent"],
      ),
    ).toEqual([]);
    expect(
      warn(
        `<style>.card { --accent-2: red; --my--accent: red; color: var(--accent) }</style>`,
        ["--accent"],
      ),
    ).toEqual([]);
  });

  it("warns about a text slot that holds other elements", () => {
    expect(
      warn(`<h1 data-kim-text="headline"><em>Plan</em> it</h1>`, ["#headline"]),
    ).toEqual([expect.stringContaining("holds other elements")]);
  });

  it("has nothing to say about the skill's example", () => {
    const skill = readFileSync(
      join(process.cwd(), "skills/interviewer/SKILL.md"),
      "utf8",
    );
    const example = /```html\n([\s\S]*?data-kim-plan[\s\S]*?)```/.exec(
      skill,
    )?.[1];
    expect(example).toBeDefined();
    expect(warn(example!, ["--accent", "@plan", "#headline"])).toEqual([]);
    expect(
      missingControls(example!, ["--accent", "@plan", "#headline"]),
    ).toEqual([]);
  });

  it("leaves undeclared controls to the binding checks", () => {
    expect(warn(`<p>Hi</p>`, ["--accent", "@nav", "#headline"])).toEqual([]);
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

  it("applies a merged message over what it has", () => {
    start({ "--accent": "red" });
    frame.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "kim-set", values: { "@nav": "top" }, merge: true },
        source: frame.parent,
      }),
    );
    expect(root().style.getPropertyValue("--accent")).toBe("red");
    expect(root().getAttribute("data-kim-nav")).toBe("top");
  });

  it("tells the page what it set, for a mockup drawn by a script", () => {
    start({});
    const seen: unknown[] = [];
    frame.addEventListener("kim-change", (event) =>
      seen.push((event as CustomEvent).detail.values),
    );
    send({ "@nav": "top", "--accent": "red" });
    send({});
    expect(seen).toEqual([{ "@nav": "top", "--accent": "red" }, {}]);
  });

  it("sets an attribute on every element that declares it, and gives each its own back", () => {
    start({ "@nav": "top" });
    // Declared on <body> and a section as well as the root.
    const body = frame.document.body;
    body.setAttribute("data-kim-nav", "software");
    body.innerHTML = '<section data-kim-nav="inner"></section>';
    const section = body.querySelector("section")!;
    send({ "@nav": "content" });
    expect(
      [root(), body, section].map((el) => el.getAttribute("data-kim-nav")),
    ).toEqual(["content", "content", "content"]);
    send({});
    expect(
      [root(), body, section].map((el) => el.getAttribute("data-kim-nav")),
    ).toEqual(["side", "software", "inner"]);
    // An element without it gets nothing.
    expect(body.querySelector("[data-kim-other]")).toBeNull();
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
