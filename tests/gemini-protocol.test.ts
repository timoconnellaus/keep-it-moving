import { describe, expect, it, vi } from "vitest";
import {
  cancelToolCalls,
  deliverClarification,
  dispatchToolCall,
} from "../src/web/geminiProtocol.js";
import type { QuestionView, SessionView } from "../src/shared/schema.js";

function response(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const question = (overrides: Partial<QuestionView>): QuestionView => ({
  id: "q1",
  type: "single-choice",
  prompt: "Pick",
  recommendation: null,
  default: null,
  options: ["A", "B"],
  min: null,
  max: null,
  step: null,
  position: 0,
  artifactId: null,
  optionArtifacts: {},
  answer: null,
  ...overrides,
});

const session: SessionView = {
  id: "s1",
  title: "Plan",
  token: "token",
  status: "active",
  url: "",
  createdAt: "",
  updatedAt: "",
  focusedQuestionId: null,
  focusedQuestionIds: [],
  focusSource: null,
  questions: [
    question({ id: "q1", default: ["A"] }),
    question({
      id: "q2",
      type: "multiple-choice",
      options: ["X", "Y", "Z"],
      default: ["Z", "X"],
    }),
    question({ id: "q3", default: null }),
  ],
  clarifications: [],
  notes: [],
  artifacts: [],
  stage: null,
  voice: { transcript: [], resumptionHandle: null },
};

const bodies = (fetcher: ReturnType<typeof vi.fn>) =>
  fetcher.mock.calls.map(([url, init]) => [
    url,
    JSON.parse(String((init as RequestInit).body)),
  ]);

describe("Gemini Live protocol adapter", () => {
  it("saves several answers in one call, each idempotent by call and question", async () => {
    const fetcher = vi.fn(async () => response({ revision: 1 }));
    const live = { sendToolResponse: vi.fn() };
    const result = await dispatchToolCall(
      "token",
      {
        id: "call-1",
        name: "submit_answers",
        args: {
          answers: [
            { question_id: "q1", answer_text: "B — only for now" },
            { question_id: "q3", answer_text: "A" },
          ],
        },
      },
      live,
      session,
      fetcher,
    );
    expect(result).toBe("answered");
    expect(bodies(fetcher)).toEqual([
      [
        "/api/browser/token/questions/q1/answer",
        { answer: "B — only for now", skipped: false, callId: "call-1:q1" },
      ],
      [
        "/api/browser/token/questions/q3/answer",
        { answer: "A", skipped: false, callId: "call-1:q3" },
      ],
    ]);
    expect(live.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        {
          id: "call-1",
          name: "submit_answers",
          response: { output: { saved: ["q1", "q3"] } },
          scheduling: "SILENT",
        },
      ],
    });
  });

  it("accepts defaults using the same answer text as the page", async () => {
    const fetcher = vi.fn(async () => response({ revision: 1 }));
    const live = { sendToolResponse: vi.fn() };
    await dispatchToolCall(
      "token",
      {
        id: "call-2",
        name: "accept_defaults",
        args: { question_ids: ["q1", "q2", "q3"] },
      },
      live,
      session,
      fetcher,
    );
    expect(bodies(fetcher).map(([, body]) => body.answer)).toEqual([
      "A",
      "X, Z",
    ]);
    // A question without a default is reported, and Gemini is prompted to say so.
    expect(live.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        expect.objectContaining({
          response: {
            output: { saved: ["q1", "q2"] },
            error: [
              { question_id: "q3", error: "This question has no default" },
            ],
          },
          scheduling: "WHEN_IDLE",
        }),
      ],
    });
  });

  it("skips questions and reports server rejections", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ revision: 1 }))
      .mockResolvedValueOnce(response({ error: "Session is stopped" }, false));
    const live = { sendToolResponse: vi.fn() };
    await dispatchToolCall(
      "token",
      {
        id: "call-3",
        name: "skip_questions",
        args: { question_ids: ["q1", "q2"] },
      },
      live,
      session,
      fetcher,
    );
    expect(bodies(fetcher)[0]![1]).toMatchObject({ skipped: true });
    expect(
      live.sendToolResponse.mock.calls[0]![0].functionResponses[0],
    ).toMatchObject({
      response: {
        output: { saved: ["q1"] },
        error: [{ question_id: "q2", error: "Session is stopped" }],
      },
      scheduling: "WHEN_IDLE",
    });
  });

  it("leaves clarification unresolved until the eventual correlated reply", async () => {
    const fetcher = vi.fn(async () => response({ id: "request-1" }));
    const live = { sendToolResponse: vi.fn() };
    const result = await dispatchToolCall(
      "token",
      {
        id: "call-clarify",
        name: "request_clarification",
        args: { question_id: "q1", request: "Explain this" },
      },
      live,
      session,
      fetcher,
    );
    expect(result).toBe("pending");
    expect(live.sendToolResponse).not.toHaveBeenCalled();
    deliverClarification(
      {
        id: "request-1",
        questionId: "q1",
        callId: "call-clarify",
        request: "Explain this",
        response: "Context from core",
        status: "answered",
      },
      live,
    );
    expect(live.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        expect.objectContaining({
          id: "call-clarify",
          name: "request_clarification",
          response: { output: "Context from core" },
        }),
      ],
    });
  });

  it("focuses the group of questions Gemini is discussing", async () => {
    const fetcher = vi.fn(async () => response({ ok: true }));
    const live = { sendToolResponse: vi.fn() };
    await dispatchToolCall(
      "token",
      {
        id: "call-focus",
        name: "focus_questions",
        args: { question_ids: ["q1", "q2"] },
      },
      live,
      session,
      fetcher,
    );
    expect(bodies(fetcher)).toEqual([
      ["/api/browser/token/focus", { questionIds: ["q1", "q2"] }],
    ]);
    expect(live.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        expect.objectContaining({ id: "call-focus", scheduling: "SILENT" }),
      ],
    });
  });

  it("puts a workspace item on screen for the user", async () => {
    const fetcher = vi.fn(async () => response({ ok: true }));
    const live = { sendToolResponse: vi.fn() };
    await dispatchToolCall(
      "token",
      { id: "call-show", name: "show_artifact", args: { artifact_id: "m1" } },
      live,
      session,
      fetcher,
    );
    expect(bodies(fetcher)).toEqual([
      ["/api/browser/token/stage", { artifactId: "m1", source: "gemini" }],
    ]);
    expect(
      live.sendToolResponse.mock.calls[0]![0].functionResponses[0],
    ).toMatchObject({ scheduling: "SILENT" });
  });

  it("passes notes to the interviewer without prompting Gemini to talk", async () => {
    const fetcher = vi.fn(async () => response({ id: "note-1" }));
    const live = { sendToolResponse: vi.fn() };
    await dispatchToolCall(
      "token",
      {
        id: "call-note",
        name: "note_for_interviewer",
        args: { note: "Offline mode is a must for v1" },
      },
      live,
      session,
      fetcher,
    );
    expect(bodies(fetcher)).toEqual([
      [
        "/api/browser/token/notes",
        {
          text: "Offline mode is a must for v1",
          questionId: null,
          callId: "call-note",
        },
      ],
    ]);
    expect(
      live.sendToolResponse.mock.calls[0]![0].functionResponses[0],
    ).toMatchObject({
      scheduling: "SILENT",
    });
  });

  it("forwards cancellation for every function call ID", async () => {
    const fetcher = vi.fn(async () => response({ ok: true }));
    await cancelToolCalls("token", ["one", "two"], fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/browser/token/tools/one/cancel",
      { method: "POST" },
    );
  });
});
