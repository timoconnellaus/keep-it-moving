import { FunctionResponseScheduling, type Session } from "@google/genai";
import { defaultAnswerText } from "../shared/answers.js";
import type { ClarificationView, SessionView } from "../shared/schema.js";

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};
export type Fetcher = typeof fetch;
type Live = Pick<Session, "sendToolResponse">;

export type PlannedAnswer = {
  questionId: string;
  answer: string;
  skipped: boolean;
  error?: string;
};

const idList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];

/** The answers an answer-saving tool call will write, before it is dispatched. */
export function plannedAnswers(
  call: ToolCall,
  session: SessionView,
): PlannedAnswer[] {
  switch (call.name) {
    case "submit_answer": // pre-batch name, kept for resumed sessions
      return [
        {
          questionId: String(call.args.question_id),
          answer: String(call.args.answer_text ?? ""),
          skipped: false,
        },
      ];
    case "submit_answers":
      return (Array.isArray(call.args.answers) ? call.args.answers : []).map(
        (item: { question_id?: unknown; answer_text?: unknown }) => ({
          questionId: String(item?.question_id),
          answer: String(item?.answer_text ?? ""),
          skipped: false,
        }),
      );
    case "accept_defaults":
      return idList(call.args.question_ids).map((questionId) => {
        const question = session.questions.find(
          (item) => item.id === questionId,
        );
        const answer = question ? defaultAnswerText(question) : null;
        return answer === null
          ? {
              questionId,
              answer: "",
              skipped: false,
              error: question
                ? "This question has no default"
                : "Unknown question",
            }
          : { questionId, answer, skipped: false };
      });
    case "skip_questions":
      return idList(call.args.question_ids).map((questionId) => ({
        questionId,
        answer: "",
        skipped: true,
      }));
    default:
      return [];
  }
}

const ANSWER_TOOLS = new Set([
  "submit_answer",
  "submit_answers",
  "accept_defaults",
  "skip_questions",
]);

function respond(
  live: Live,
  call: ToolCall,
  response: Record<string, unknown>,
  scheduling: FunctionResponseScheduling,
) {
  live.sendToolResponse({
    functionResponses: [{ id: call.id, name: call.name, response, scheduling }],
  });
}

async function post(
  fetcher: Fetcher,
  url: string,
  body: unknown,
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    ok: response.ok,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/**
 * Runs one Gemini function call against the local service. Successful results
 * are SILENT, since Gemini has already told the user what it is doing; failures
 * are WHEN_IDLE so it can tell them something went wrong.
 */
export async function dispatchToolCall(
  token: string,
  call: ToolCall,
  live: Live,
  session: SessionView,
  fetcher: Fetcher = fetch,
): Promise<"answered" | "pending" | "ignored"> {
  const base = `/api/browser/${token}`;
  if (ANSWER_TOOLS.has(call.name)) {
    const planned = plannedAnswers(call, session);
    const saved: string[] = [];
    const errors: Array<{ question_id: string; error: string }> = [];
    if (!planned.length)
      errors.push({ question_id: "", error: "No questions given" });
    for (const item of planned) {
      if (item.error) {
        errors.push({ question_id: item.questionId, error: item.error });
        continue;
      }
      const result = await post(
        fetcher,
        `${base}/questions/${encodeURIComponent(item.questionId)}/answer`,
        {
          answer: item.answer,
          skipped: item.skipped,
          callId: `${call.id}:${item.questionId}`,
        },
      );
      if (result.ok) saved.push(item.questionId);
      else
        errors.push({
          question_id: item.questionId,
          error: String(result.body.error ?? "Could not save"),
        });
    }
    respond(
      live,
      call,
      errors.length
        ? { output: { saved }, error: errors }
        : { output: { saved } },
      errors.length
        ? FunctionResponseScheduling.WHEN_IDLE
        : FunctionResponseScheduling.SILENT,
    );
    return "answered";
  }
  if (call.name === "focus_questions" || call.name === "focus_question") {
    const questionIds =
      call.name === "focus_question"
        ? [String(call.args.question_id)]
        : idList(call.args.question_ids);
    const result = await post(fetcher, `${base}/focus`, { questionIds });
    respond(
      live,
      call,
      result.ok ? { output: "ok" } : { error: result.body },
      FunctionResponseScheduling.SILENT,
    );
    return "answered";
  }
  if (call.name === "show_artifact") {
    const result = await post(fetcher, `${base}/stage`, {
      artifactId: String(call.args.artifact_id ?? ""),
      source: "gemini",
    });
    respond(
      live,
      call,
      result.ok ? { output: "shown" } : { error: result.body },
      result.ok
        ? FunctionResponseScheduling.SILENT
        : FunctionResponseScheduling.WHEN_IDLE,
    );
    return "answered";
  }
  if (call.name === "note_for_interviewer") {
    const result = await post(fetcher, `${base}/notes`, {
      text: String(call.args.note ?? ""),
      questionId: call.args.question_id ? String(call.args.question_id) : null,
      callId: call.id,
    });
    respond(
      live,
      call,
      result.ok ? { output: "delivered" } : { error: result.body },
      result.ok
        ? FunctionResponseScheduling.SILENT
        : FunctionResponseScheduling.WHEN_IDLE,
    );
    return "answered";
  }
  if (call.name === "request_clarification") {
    const result = await post(fetcher, `${base}/clarifications`, {
      questionId: String(call.args.question_id),
      request: String(call.args.request ?? ""),
      callId: call.id,
    });
    if (result.ok) return "pending";
    respond(
      live,
      call,
      { error: result.body },
      FunctionResponseScheduling.WHEN_IDLE,
    );
    return "answered";
  }
  respond(
    live,
    call,
    { error: `Unknown function ${call.name}` },
    FunctionResponseScheduling.WHEN_IDLE,
  );
  return "ignored";
}

export function deliverClarification(
  clarification: ClarificationView,
  live: Live,
): void {
  if (clarification.status !== "answered" || !clarification.response) return;
  live.sendToolResponse({
    functionResponses: [
      {
        id: clarification.callId,
        name: "request_clarification",
        response: { output: clarification.response },
        scheduling: FunctionResponseScheduling.WHEN_IDLE,
      },
    ],
  });
}

export async function cancelToolCalls(
  token: string,
  callIds: string[],
  fetcher: Fetcher = fetch,
): Promise<void> {
  await Promise.all(
    callIds.map((id) =>
      fetcher(`/api/browser/${token}/tools/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      }),
    ),
  );
}
