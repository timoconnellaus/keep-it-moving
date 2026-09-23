import { describe, expect, it } from "vitest";
import {
  describeChanges,
  describeQuestionnaire,
  recordOwnAnswers,
  snapshotQuestionnaire,
} from "../src/web/geminiContext.js";
import { Downsampler } from "../src/web/micCapture.js";
import type { QuestionView, SessionView } from "../src/shared/schema.js";

const question = (overrides: Partial<QuestionView>): QuestionView => ({
  id: "q1",
  type: "single-choice",
  prompt: "Where should data live?",
  recommendation: "Local-first keeps it\n\nfast.",
  default: ["Local"],
  options: ["Local", "Cloud"],
  min: null,
  max: null,
  step: null,
  position: 0,
  artifactId: null,
  optionArtifacts: {},
  answer: null,
  ...overrides,
});

const base = (): SessionView => ({
  id: "s1",
  title: "Todo plan",
  token: "t",
  status: "active",
  url: "",
  createdAt: "",
  updatedAt: "",
  focusedQuestionId: null,
  focusedQuestionIds: [],
  focusSource: null,
  questions: [question({})],
  clarifications: [],
  notes: [],
  artifacts: [],
  stage: null,
  voice: { transcript: [], resumptionHandle: null },
});

describe("Gemini questionnaire context", () => {
  it("describes each question on one line with its default and state", () => {
    const text = describeQuestionnaire(base());
    expect(text).toContain("1 questions, 1 open.");
    expect(text).toContain(
      '#1 id=q1 single-choice: "Where should data live?" Options: Local | Cloud. Suggested: Local. Why: Local-first keeps it fast. Open.',
    );
  });

  it("reports nothing when nothing Gemini needs to know changed", () => {
    const session = base();
    expect(describeChanges(snapshotQuestionnaire(session), session)).toBeNull();
  });

  it("reports added, removed, and on-screen answers as a silent update", () => {
    const before = base();
    before.questions.push(question({ id: "gone", prompt: "Old question" }));
    const known = snapshotQuestionnaire(before);
    const after = base();
    after.questions[0]!.answer = {
      text: "Cloud",
      skipped: false,
      revision: 1,
      delivered: false,
      updatedAt: "",
    };
    after.questions.push(
      question({ id: "q9", prompt: "Which sync provider?", default: null }),
    );
    const update = describeChanges(known, after)!;
    expect(update.speak).toBe(false);
    expect(update.text).toContain('On screen, the user answered #1: "Cloud"');
    expect(update.text).toContain(
      'Added #2 id=q9 single-choice: "Which sync provider?"',
    );
    expect(update.text).toContain('Removed id=gone: "Old question"');
    expect(update.text).toContain("Now 1 of 2 questions are open.");
  });

  it("does not echo answers Gemini saved itself", () => {
    const session = base();
    const known = snapshotQuestionnaire(session);
    recordOwnAnswers(known, [
      { questionId: "q1", answer: "Local", skipped: false },
    ]);
    session.questions[0]!.answer = {
      text: "Local",
      skipped: false,
      revision: 1,
      delivered: false,
      updatedAt: "",
    };
    expect(describeChanges(known, session)).toBeNull();
  });

  it("relays new interviewer notes once, speaking only when asked", () => {
    const session = base();
    const known = snapshotQuestionnaire(session);
    session.notes.push({
      id: "n1",
      from: "agent",
      text: "I added a sync diagram.",
      questionId: null,
      speak: true,
      createdAt: "",
    });
    const update = describeChanges(known, session)!;
    expect(update.text).toContain(
      "Message from the interviewer: I added a sync diagram.",
    );
    expect(update.speak).toBe(true);
    expect(describeChanges(snapshotQuestionnaire(session), session)).toBeNull();
  });
});

describe("Gemini workspace context", () => {
  const withWorkspace = () => {
    const session = base();
    session.artifacts = [
      {
        id: "p1",
        kind: "plan",
        title: "Plan",
        format: "markdown",
        content: "## Decisions\n- Local-first",
        size: 0,
        description: null,
        revision: 1,
        updatedAt: "",
      },
      {
        id: "d1",
        kind: "diagram",
        title: "Sync architecture",
        format: "html",
        content: "<!doctype html><html></html>",
        source: JSON.stringify({
          diagram_type: "architecture",
          meta: { title: "Sync", quality_profile: "showcase" },
          components: [
            { id: "ui", label: "App UI", pos: [40, 300], size: [130, 60] },
          ],
          connections: [
            { from: "ui", to: "api", label: "push", via: [[1, 2]] },
          ],
        }),
        size: 0,
        description: null,
        revision: 1,
        updatedAt: "",
      },
      {
        id: "m1",
        kind: "mockup",
        title: "Layout A",
        format: "html",
        content: "<main></main>",
        size: 0,
        description: "Sidebar navigation",
        revision: 1,
        updatedAt: "",
      },
    ];
    session.questions[0]!.optionArtifacts = { Local: "m1" };
    return session;
  };

  it("lists the workspace, what is on screen, and the plan text", () => {
    const text = describeQuestionnaire(withWorkspace());
    expect(text).toContain("Options: Local [artifact id=m1] | Cloud.");
    expect(text).toContain('- mockup "Layout A" (id=m1): Sidebar navigation');
    expect(text).toContain('On screen: plan "Plan" (id=p1).');
    expect(text).toContain("Plan (revision 1):\n## Decisions\n- Local-first");
  });

  it("asks for a picture when a diagram or mockup comes on screen", () => {
    const session = withWorkspace();
    const known = snapshotQuestionnaire(session);
    session.stage = { artifactId: "d1", source: "user" };
    const update = describeChanges(known, session)!;
    expect(update.showImage).toBe(true);
    // Voice gets the archify spec's meaning, without coordinates or styling.
    expect(update.text).toContain(
      '- On screen: diagram "Sync architecture" (id=d1), put there by the user.\nDiagram spec:\n{"diagram_type":"architecture","meta":{"title":"Sync"},"components":[{"id":"ui","label":"App UI"}],"connections":[{"from":"ui","to":"api","label":"push"}]}',
    );
  });

  it("sends a revised plan as text, without a picture", () => {
    const session = withWorkspace();
    const known = snapshotQuestionnaire(session);
    session.artifacts[0] = {
      ...session.artifacts[0]!,
      content: "## Decisions\n- Local-first\n- iOS + Web",
      revision: 2,
    };
    const update = describeChanges(known, session)!;
    expect(update.showImage).toBe(false);
    expect(update.text).toContain(
      "The interviewer updated the plan (revision 2):\n## Decisions\n- Local-first\n- iOS + Web",
    );
  });
});

describe("microphone downsampling", () => {
  it("averages each output span, carrying fractional positions across chunks", () => {
    const downsampler = new Downsampler(48_000, 16_000);
    const first = downsampler.push(new Float32Array([0.3, 0.6, 0.9, 1, 1]));
    const second = downsampler.push(new Float32Array([1, -1, -1, -1]));
    expect(Array.from(first)).toEqual([Math.round(0.6 * 32767)]);
    expect(Array.from(second)).toEqual([32767, -32768]);
  });

  it("passes samples straight through at the target rate", () => {
    const downsampler = new Downsampler(16_000, 16_000);
    expect(downsampler.push(new Float32Array([0, 0.5, -0.5])).length).toBe(3);
  });
});
