import { describe, expect, it } from "vitest";
import type { ArtifactView, QuestionView } from "../src/shared/schema.js";
import { frameSize, layoutCanvas } from "../src/web/canvasLayout.js";

const artifact = (
  id: string,
  kind: ArtifactView["kind"],
  title = id,
  description: string | null = null,
): ArtifactView => ({
  id,
  kind,
  title,
  format: kind === "plan" || kind === "document" ? "markdown" : "html",
  size: 0,
  description,
  revision: 1,
  updatedAt: "",
});
const question = (
  id: string,
  overrides: Partial<QuestionView>,
): QuestionView => ({
  id,
  type: "single-choice",
  prompt: `Prompt ${id}`,
  recommendation: null,
  default: null,
  options: [],
  min: null,
  max: null,
  step: null,
  position: 0,
  artifactId: null,
  optionArtifacts: {},
  optionValues: {},
  control: null,
  unit: null,
  answer: null,
  ...overrides,
});

describe("the canvas layout", () => {
  const artifacts = [
    artifact("plan", "plan", "Plan"),
    artifact("a", "mockup", "Layout A"),
    artifact("b", "mockup", "Layout B"),
    artifact("m", "mockup", "Layout A · Mobile"),
    artifact("notes", "document", "Notes"),
  ];
  const questions = [
    question("q1", {}),
    question("q2", {
      options: ["One", "Two"],
      optionArtifacts: { One: "a", Two: "b" },
    }),
    // Also about A, which q2 already shows.
    question("q3", { artifactId: "a" }),
    question("q4", { artifactId: "m", type: "text" }),
  ];

  it("puts loose artifacts first, the plan leading, then a row per question that names new ones", () => {
    const { rows, frames } = layoutCanvas({ artifacts, questions }, {}, {});
    expect(rows.map((row) => [row.title, row.note, row.y])).toEqual([
      ["Plan", "and items not tied to a question", 0],
      ["Question 2", "Prompt q2", 1460],
      ["Question 4", "Prompt q4", 1460 + 800 + 700],
    ]);
    expect(frames.map((frame) => [frame.id, frame.x, frame.y])).toEqual([
      ["plan", 0, 0],
      ["notes", 740, 0],
      ["a", 0, 1460],
      ["b", 1400, 1460],
      ["m", 0, 2960],
    ]);
  });

  it("makes room for a document's measured height", () => {
    const { rows } = layoutCanvas(
      { artifacts, questions },
      {},
      { notes: 1500 },
    );
    expect(rows[1]!.y).toBe(1500 + 700);
  });

  it("keeps a moved frame where it was put without moving the others", () => {
    const { frames } = layoutCanvas(
      { artifacts, questions },
      { a: { x: -50, y: 4000 } },
      {},
    );
    expect(frames.find((frame) => frame.id === "a")).toMatchObject({
      x: -50,
      y: 4000,
    });
    expect(frames.find((frame) => frame.id === "b")).toMatchObject({
      x: 1400,
      y: 1460,
    });
  });

  it("adds a row of copies, one per option, to compare", () => {
    const font = question("q5", {
      artifactId: "a",
      options: ["Inter", "Fraunces"],
      optionValues: {
        Inter: { "--f": "Inter" },
        Fraunces: { "--f": "Fraunces" },
      },
    });
    const { rows, copies } = layoutCanvas(
      { artifacts, questions: [...questions, font] },
      {},
      {},
      { question: font, artifact: artifacts[1]! },
    );
    expect(rows.at(-1)).toMatchObject({
      title: "Question 5",
      note: "Comparing options on Layout A",
      y: 2960 + 844 + 700,
    });
    expect(copies.map((copy) => [copy.option, copy.x])).toEqual([
      ["Inter", 0],
      ["Fraunces", 1400],
    ]);
  });

  it("sizes frames by kind, and phones and tablets by name", () => {
    expect(frameSize(artifacts[0]!)).toEqual({ w: 620, h: null });
    expect(frameSize(artifacts[1]!)).toEqual({ w: 1280, h: 800 });
    expect(frameSize(artifacts[3]!)).toEqual({ w: 390, h: 844 });
    expect(frameSize(artifact("t", "mockup", "Board", "On a tablet"))).toEqual({
      w: 834,
      h: 1112,
    });
  });
});
