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
  /**
   * Whether the workspace column starts open. Closed by default, since the
   * user may follow the plan elsewhere, such as a Markdown file or a design.
   */
  stageVisible: z.boolean().default(false),
  /** Where the interview runs; the CLI detects it from git and the environment. */
  origin: z
    .object({
      /** Normalized git remote, e.g. github.com/owner/repo, or local/<folder>. */
      projectKey: z.string().trim().min(1).max(300).optional(),
      /** Name for a project this key creates. */
      projectName: z.string().trim().min(1).max(100).optional(),
      /** An existing project's name or key, chosen by the agent; wins over projectKey. */
      project: z.string().trim().min(1).max(300).optional(),
      branch: z.string().trim().min(1).max(300).optional(),
      worktree: z.string().trim().min(1).max(300).optional(),
      agent: z.string().trim().min(1).max(100).optional(),
      agentSession: z.string().trim().min(1).max(200).optional(),
      location: z.enum(["local", "cloud"]).optional(),
    })
    .default({}),
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
  /** A summary of what the artifact shows, e.g. a mockup's layout. */
  description: z.string().trim().max(5_000).nullable(),
  /** What a rendered artifact was built from, e.g. an archify diagram's JSON spec. */
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
  })
  .refine((value) => value.skipped || value.answer.trim().length > 0, {
    message: "An answer is required unless the question is skipped",
    path: ["answer"],
  });

/** A message in an interview's chat: a clarification, or a direction for the agent. */
export const ChatInputSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** The user's message is about this question. */
  questionId: z.string().uuid().nullable().optional(),
  /** The agent's reply answers this message. */
  replyTo: z.string().uuid().nullable().optional(),
});

export type ChatAuthor = "user" | "agent";
/** One message in an interview's single chat thread. */
export interface ChatMessageView {
  id: string;
  author: ChatAuthor;
  /** Markdown. */
  text: string;
  questionId: string | null;
  replyTo: string | null;
  /** A user's message reached the agent, as an answer does. */
  delivered: boolean;
  createdAt: string;
  /** The assignee who wrote it; null for the owner and the agent. */
  authorEmail: string | null;
}

export type SessionStatus = "active" | "stopped";
export interface AnswerView {
  text: string;
  skipped: boolean;
  revision: number;
  delivered: boolean;
  updatedAt: string;
  /** The assignee who answered; null when the owner did. */
  answeredBy: string | null;
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
export type StageSource = "agent" | "user";
/** A codebase interviews belong to, with a colour that stays the same everywhere. */
export interface ProjectView {
  id: string;
  key: string;
  name: string;
  color: string;
}
/** Where an interview is running: the worktree and the agent session that started it. */
export interface OriginView {
  branch: string | null;
  worktree: string | null;
  agent: string | null;
  agentSession: string | null;
  location: "local" | "cloud" | null;
}
/** One interview in the switcher and on the home page. */
export interface SessionSummary {
  id: string;
  token: string;
  title: string;
  status: SessionStatus;
  project: ProjectView | null;
  origin: OriginView;
  answered: number;
  total: number;
  /** Unanswered questions in an active interview: they wait on the user. */
  open: number;
  /** Who the interview is assigned to answer it; its open questions wait on them. */
  assignee: string | null;
  lastActivity: string;
  /** The agent's latest chat message, for the reply notification. */
  lastReply: { text: string; at: string } | null;
  /** The latest chat message is the user's (or assignee's): the agent owes a reply. */
  awaitingReply: boolean;
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
  questions: QuestionView[];
  /** The plan first, then other artifacts in the order they were added. */
  artifacts: ArtifactView[];
  /** The artifact someone put on screen; null means the default (see shownArtifact). */
  stage: { artifactId: string; source: StageSource } | null;
  /** Whether the workspace column is open, and who last opened or closed it. */
  stageVisible: boolean;
  stageVisibilitySource: StageSource | null;
  project: ProjectView | null;
  origin: OriginView;
  /** The chat with the agent, oldest first. */
  chat: ChatMessageView[];
  /** Browser views only: whether an agent is waiting on this interview now. */
  agentWatching?: boolean;
  /** Someone else answers this interview: the owner sends them the link. */
  assignee: string | null;
  /** The owner's name (or email) as the assignee sees it. */
  assignedBy: string | null;
  /** Browser views only: the viewer is the assignee, not the owner. */
  respondent?: boolean;
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
