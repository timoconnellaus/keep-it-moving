import { z } from "zod";

export const questionTypes = [
  "text",
  "single-choice",
  "multiple-choice",
  "yes-no",
  "number",
] as const;
export const QuestionTypeSchema = z.enum(questionTypes);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

export const SessionInputSchema = z.object({
  title: z.string().trim().min(1).max(200).default("Untitled interview"),
});

const DefaultValueSchema = z.union([
  z.string().trim().min(1).max(10_000),
  z.number().finite().transform(String),
  z.boolean().transform((value) => (value ? "Yes" : "No")),
]);

const questionFields = {
  type: QuestionTypeSchema,
  prompt: z.string().trim().min(1).max(10_000),
  recommendation: z.string().max(20_000).nullable(),
  /** The recommended answer: one option (or several for multiple-choice), a number, or suggested text. */
  default: z
    .union([DefaultValueSchema, z.array(DefaultValueSchema).min(1).max(100)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .nullable(),
  options: z.array(z.string().trim().min(1).max(1_000)).max(100),
  /** The workspace artifact this question is about; focusing the question shows it. */
  artifactId: z.string().uuid().nullable(),
  /** Option label → artifact id, for choices between visuals such as mockups. */
  optionArtifacts: z.record(z.string(), z.string().uuid()),
  min: z.number().finite().nullable(),
  max: z.number().finite().nullable(),
  step: z.number().finite().positive().nullable(),
  position: z.number().int().nonnegative(),
};

export const QuestionInputSchema = z
  .object(questionFields)
  .partial()
  .extend({
    type: questionFields.type.default("text"),
    prompt: questionFields.prompt,
    options: questionFields.options.default([]),
  });
export type QuestionInput = z.input<typeof QuestionInputSchema>;

// Built from the raw fields so omitted keys stay undefined rather than taking creation defaults.
export const QuestionPatchSchema = z.object(questionFields).partial().extend({
  id: z.string().uuid().optional(),
});

export const artifactKinds = ["plan", "document", "diagram", "mockup"] as const;
export type ArtifactKind = (typeof artifactKinds)[number];

/** Content can be a whole HTML mockup, so allow well past the default body size. */
export const ARTIFACT_MAX_BYTES = 4_000_000;

const artifactFields = {
  title: z.string().trim().min(1).max(200),
  content: z.string().max(ARTIFACT_MAX_BYTES),
  /** Read to voice in place of content it can't use directly, such as mockup HTML. */
  description: z.string().trim().max(5_000).nullable(),
  /** What a rendered artifact was built from, e.g. an archify diagram's JSON spec; voice reads it. */
  source: z.string().max(ARTIFACT_MAX_BYTES).nullable(),
  /** Put the artifact on screen as part of this change. */
  show: z.boolean(),
};

export const ArtifactInputSchema = z
  .object(artifactFields)
  .partial()
  .extend({
    kind: z.enum(artifactKinds),
    title: artifactFields.title,
    content: artifactFields.content,
    show: artifactFields.show.default(false),
  });
export const ArtifactPatchSchema = z.object(artifactFields).partial();

export const AnswerInputSchema = z
  .object({
    answer: z.string().max(100_000).default(""),
    skipped: z.boolean().default(false),
    callId: z.string().max(500).optional(),
  })
  .refine((value) => value.skipped || value.answer.trim().length > 0, {
    message: "An answer is required unless the question is skipped",
    path: ["answer"],
  });

export const NoteInputSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  questionId: z.string().uuid().nullable().optional(),
  /** Agent notes only: prompt voice to relay the note as soon as it is idle. */
  speak: z.boolean().default(false),
  callId: z.string().trim().min(1).max(500).optional(),
});

export const ClarificationInputSchema = z.object({
  questionId: z.string().uuid(),
  request: z.string().trim().min(1).max(20_000),
  callId: z.string().trim().min(1).max(500),
});

export type SessionStatus = "active" | "stopped";
export interface AnswerView {
  text: string;
  skipped: boolean;
  revision: number;
  delivered: boolean;
  updatedAt: string;
}
export interface QuestionView {
  id: string;
  type: QuestionType;
  prompt: string;
  recommendation: string | null;
  /** Recommended answer values; several only for multiple-choice. */
  default: string[] | null;
  options: string[];
  min: number | null;
  max: number | null;
  step: number | null;
  position: number;
  artifactId: string | null;
  optionArtifacts: Record<string, string>;
  answer: AnswerView | null;
}
/**
 * A plan, document, diagram (archify HTML or SVG), or HTML mockup shown
 * beside the questions. Agent-facing responses omit `content`.
 */
export interface ArtifactView {
  id: string;
  kind: ArtifactKind;
  title: string;
  /** How the stage renders it; html is served from its own sandboxed URL. */
  format: ArtifactFormat;
  /** Omitted for agents, who wrote it, and for html, which loads by URL. */
  content?: string;
  size: number;
  description: string | null;
  /** Omitted for agents. */
  source?: string | null;
  revision: number;
  updatedAt: string;
}
export type ArtifactFormat = "markdown" | "html" | "svg" | "text";
export type StageSource = "agent" | "gemini" | "user";
export interface ClarificationView {
  id: string;
  questionId: string;
  callId: string;
  request: string;
  response: string | null;
  status: "pending" | "answered" | "cancelled";
}
/** A message between voice and the interviewing agent that isn't an answer. */
export interface NoteView {
  id: string;
  from: "voice" | "agent";
  text: string;
  questionId: string | null;
  speak: boolean;
  createdAt: string;
}
export interface SessionView {
  id: string;
  title: string;
  token: string;
  status: SessionStatus;
  url: string;
  createdAt: string;
  updatedAt: string;
  focusedQuestionId: string | null;
  /** Every question in the focused group; the first is focusedQuestionId. */
  focusedQuestionIds: string[];
  focusSource: "agent" | "gemini" | null;
  questions: QuestionView[];
  clarifications: ClarificationView[];
  /** The most recent notes, oldest first. */
  notes: NoteView[];
  /** The plan first, then other artifacts in the order they were added. */
  artifacts: ArtifactView[];
  /** The artifact someone put on screen; null means the default (see shownArtifact). */
  stage: { artifactId: string; source: StageSource } | null;
  voice: {
    transcript: Array<{ role: "user" | "model"; text: string }>;
    resumptionHandle: string | null;
  };
}
export interface InterviewEvent {
  id: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const matchOption = (options: string[], value: string) =>
  options.find(
    (option) => option.trim().toLowerCase() === value.trim().toLowerCase(),
  );

/** Checks a default against its question's type and options, returning canonical option spellings. */
export function normalizeDefault(
  type: QuestionType,
  options: string[],
  values: string[] | null,
): string[] | null {
  if (!values) return null;
  if (type !== "multiple-choice" && values.length !== 1)
    throw new Error(`A ${type} question takes exactly one default value`);
  if (type === "text" || type === "number") return values;
  const choices = type === "yes-no" ? ["Yes", "No"] : options;
  const normalized = values.map((value) => {
    const match = matchOption(choices, value);
    if (!match)
      throw new Error(
        `Default "${value}" is not one of the options: ${choices.join(", ")}`,
      );
    return match;
  });
  return choices.filter((choice) => normalized.includes(choice));
}
