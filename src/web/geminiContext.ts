import { choicesFor } from "../shared/answers.js";
import type {
  ArtifactView,
  NoteView,
  QuestionView,
  SessionView,
} from "../shared/schema.js";
import { shownArtifact } from "../shared/workspace.js";

/** What Gemini has been told: questions, notes, workspace items, and what is on screen. */
export interface QuestionnaireSnapshot {
  questions: Map<
    string,
    { number: number; spec: string; prompt: string; answer: string | null }
  >;
  noteIds: Set<string>;
  artifacts: Map<string, { label: string; revision: number }>;
  shown: { id: string; revision: number } | null;
}

/** Limits on artifact text sent to voice; the plan matters most. */
const PLAN_CHARS = 6_000;
const DIAGRAM_CHARS = 4_000;

/** How many recent notes a fresh Live session is given. */
const RECENT_NOTES = 10;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function answerState(question: QuestionView): string | null {
  if (!question.answer) return null;
  return question.answer.skipped ? "[skipped]" : question.answer.text;
}

/** Everything about a question except its answer. */
function questionSpec(question: QuestionView): string {
  const parts = [`${question.type}: "${oneLine(question.prompt)}"`];
  if (question.artifactId)
    parts.push(`About artifact id=${question.artifactId}.`);
  const choices = choicesFor(question);
  if (question.type !== "yes-no" && choices.length)
    parts.push(
      `Options: ${choices
        .map((option) =>
          question.optionArtifacts[option]
            ? `${option} [artifact id=${question.optionArtifacts[option]}]`
            : option,
        )
        .join(" | ")}.`,
    );
  if (
    question.type === "number" &&
    (question.min !== null || question.max !== null)
  )
    parts.push(`Range: ${question.min ?? "any"} to ${question.max ?? "any"}.`);
  if (question.default)
    parts.push(`Suggested: ${question.default.join(", ")}.`);
  if (question.recommendation)
    parts.push(`Why: ${oneLine(question.recommendation)}`);
  return parts.join(" ");
}

function describeAnswer(answer: string | null): string {
  if (answer === null) return "Open.";
  if (answer === "[skipped]") return "Skipped.";
  return `Answered: "${oneLine(answer)}".`;
}

function describeQuestion(question: QuestionView, number: number): string {
  return `#${number} id=${question.id} ${questionSpec(question)} ${describeAnswer(answerState(question))}`;
}

const openCount = (session: SessionView) =>
  session.questions.filter((question) => !question.answer).length;

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n[…truncated]` : text;

function artifactLabel(artifact: ArtifactView): string {
  return `${artifact.kind} "${oneLine(artifact.title)}" (id=${artifact.id})`;
}

const isVisual = (artifact: ArtifactView) =>
  artifact.format === "html" || artifact.format === "svg";

/** Layout and presentation fields in an archify spec; voice needs only the meaning. */
const SPEC_LAYOUT_KEYS = new Set([
  "pos",
  "size",
  "via",
  "channelX",
  "channelY",
  "labelAt",
  "route",
  "fromSide",
  "toSide",
  "side",
  "output",
  "viewBox",
  "quality_profile",
  "visual_preset",
  "animation",
  "legend",
  "column_fit",
  "locale",
  "brand",
]);

/** An archify spec without coordinates or styling, as compact JSON. */
export function semanticSpec(source: string): string {
  try {
    return JSON.stringify(JSON.parse(source), (key, value: unknown) =>
      SPEC_LAYOUT_KEYS.has(key) ? undefined : value,
    );
  } catch {
    return oneLine(source);
  }
}

/** What voice can read of an artifact; html and SVG are also seen through a picture. */
function artifactText(artifact: ArtifactView): string | null {
  const content = artifact.content ?? "";
  if (artifact.kind === "plan" || artifact.kind === "document")
    return truncate(content, PLAN_CHARS);
  if (artifact.kind === "diagram" && artifact.source)
    return `Diagram spec:\n${truncate(semanticSpec(artifact.source), DIAGRAM_CHARS)}`;
  if (artifact.kind === "diagram" && artifact.format === "text")
    return `Diagram source:\n${truncate(content, DIAGRAM_CHARS)}`;
  return artifact.description ? oneLine(artifact.description) : null;
}

const STAGE_SOURCE = {
  user: "the user",
  gemini: "you",
  agent: "the interviewer",
} as const;

function describeShown(session: SessionView): string[] {
  const shown = shownArtifact(session);
  if (!shown) return [];
  const source =
    session.stage?.artifactId === shown.id
      ? `, put there by ${STAGE_SOURCE[session.stage.source]}`
      : "";
  const text = shown.kind === "plan" ? null : artifactText(shown);
  return [
    `On screen: ${artifactLabel(shown)}${source}.`,
    ...(text ? [text] : []),
  ];
}

export function snapshotQuestionnaire(
  session: SessionView,
): QuestionnaireSnapshot {
  const shown = shownArtifact(session);
  return {
    questions: new Map(
      session.questions.map((question, index) => [
        question.id,
        {
          number: index + 1,
          spec: questionSpec(question),
          prompt: question.prompt,
          answer: answerState(question),
        },
      ]),
    ),
    noteIds: new Set(session.notes.map((note) => note.id)),
    artifacts: new Map(
      session.artifacts.map((artifact) => [
        artifact.id,
        { label: artifactLabel(artifact), revision: artifact.revision },
      ]),
    ),
    shown: shown ? { id: shown.id, revision: shown.revision } : null,
  };
}

function describeNote(note: NoteView): string {
  const about = note.questionId ? ` (about id=${note.questionId})` : "";
  return note.from === "agent"
    ? `Message from the interviewer${about}: ${oneLine(note.text)}`
    : `You passed on${about}: ${oneLine(note.text)}`;
}

/** The full questionnaire, sent when a Live session starts or reconnects. */
export function describeQuestionnaire(session: SessionView): string {
  return [
    "Questionnaire state (from the app, not the user).",
    `Interview: ${oneLine(session.title)}. ${session.questions.length} questions, ${openCount(session)} open.`,
    ...session.questions.map((question, index) =>
      describeQuestion(question, index + 1),
    ),
    ...(session.notes.length
      ? [
          "Recent notes between you and the interviewer:",
          ...session.notes.slice(-RECENT_NOTES).map(describeNote),
        ]
      : []),
    ...describeWorkspace(session),
  ].join("\n");
}

function describeWorkspace(session: SessionView): string[] {
  if (!session.artifacts.length) return [];
  const plan = session.artifacts.find((artifact) => artifact.kind === "plan");
  return [
    "Workspace (shown beside the questions):",
    ...session.artifacts.map(
      (artifact) =>
        `- ${artifactLabel(artifact)}${artifact.kind === "mockup" && artifact.description ? `: ${oneLine(artifact.description)}` : ""}`,
    ),
    ...describeShown(session),
    ...(plan ? [`Plan (revision ${plan.revision}):`, artifactText(plan)!] : []),
  ];
}

/**
 * What changed since Gemini's snapshot, or null when nothing it needs to know
 * changed. Reordering alone is not reported. `speak` asks for the update to be
 * relayed right away rather than kept as silent context.
 */
export function describeChanges(
  known: QuestionnaireSnapshot,
  session: SessionView,
): { text: string; speak: boolean; showImage: boolean } | null {
  const lines: string[] = [];
  session.questions.forEach((question, index) => {
    const number = index + 1;
    const before = known.questions.get(question.id);
    if (!before) {
      lines.push(`- Added ${describeQuestion(question, number)}`);
      return;
    }
    if (before.spec !== questionSpec(question))
      lines.push(`- Changed ${describeQuestion(question, number)}`);
    else if (before.answer !== answerState(question))
      lines.push(
        `- On screen, the user ${answerState(question) === "[skipped]" ? `skipped #${number}` : `answered #${number}: "${oneLine(question.answer?.text ?? "")}"`}.`,
      );
  });
  const current = new Set(session.questions.map((question) => question.id));
  for (const [id, before] of known.questions)
    if (!current.has(id))
      lines.push(`- Removed id=${id}: "${oneLine(before.prompt)}"`);
  const newNotes = session.notes.filter(
    (note) => note.from === "agent" && !known.noteIds.has(note.id),
  );
  for (const note of newNotes) lines.push(`- ${describeNote(note)}`);
  for (const artifact of session.artifacts) {
    const before = known.artifacts.get(artifact.id);
    if (!before)
      lines.push(
        `- Added to the workspace: ${artifactLabel(artifact)}${artifact.kind === "mockup" && artifact.description ? `: ${oneLine(artifact.description)}` : ""}.`,
      );
    else if (before.revision !== artifact.revision)
      lines.push(
        artifact.kind === "plan"
          ? `- The interviewer updated the plan (revision ${artifact.revision}):\n${artifactText(artifact)}`
          : `- The interviewer updated ${artifactLabel(artifact)}.`,
      );
  }
  const artifactIds = new Set(session.artifacts.map((artifact) => artifact.id));
  for (const [id, before] of known.artifacts)
    if (!artifactIds.has(id))
      lines.push(`- Removed from the workspace: ${before.label}.`);
  const shown = shownArtifact(session);
  const shownChanged =
    (shown?.id ?? null) !== (known.shown?.id ?? null) ||
    (shown !== null && shown.revision !== known.shown?.revision);
  if (shownChanged && shown)
    lines.push(
      ...describeShown(session).map((line, index) =>
        index ? line : `- ${line}`,
      ),
    );
  if (!lines.length) return null;
  return {
    text: [
      "Questionnaire update (from the app, not the user):",
      ...lines,
      `Now ${openCount(session)} of ${session.questions.length} questions are open.`,
    ].join("\n"),
    speak: newNotes.some((note) => note.speak),
    showImage: shownChanged && shown !== null && isVisual(shown),
  };
}

/** Whether the item on screen is best understood from a picture. */
export function shownIsVisual(session: SessionView): boolean {
  const shown = shownArtifact(session);
  return shown !== null && isVisual(shown);
}

/** Records answers Gemini itself saved, so they aren't echoed back to it. */
export function recordOwnAnswers(
  known: QuestionnaireSnapshot,
  answers: Array<{ questionId: string; answer: string; skipped: boolean }>,
): void {
  for (const item of answers) {
    const entry = known.questions.get(item.questionId);
    if (entry) entry.answer = item.skipped ? "[skipped]" : item.answer;
  }
}
