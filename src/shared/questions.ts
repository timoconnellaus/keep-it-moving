import { defaultAnswerText } from "./answers.js";
import {
  boundControls,
  controlKind,
  isBound,
  missingControls,
  savedValues,
  type ControlValues,
} from "./bindings.js";
import type { ArtifactFormat, QuestionView } from "./schema.js";

/**
 * Checks on a question against the interview's artifacts. The service runs
 * them for plain interviews; in an encrypted one it can't read the labels
 * or the artifacts, so the client runs them before sealing and the service
 * runs only what it can see (`sealed`).
 */

/** An artifact as the checks need it; content only when it can be read. */
export interface ArtifactRef {
  id: string;
  format: ArtifactFormat;
  title: string;
  content?: string | undefined;
}

export type FindArtifact = (id: string) => ArtifactRef | undefined;

export const undeclared = (title: string, missing: string[]) =>
  `artifact "${title}" doesn't declare ${missing.join(", ")}. Define a variable (--accent: …), use data-kim-nav for @nav, or mark an element data-kim-text="headline" for #headline`;

export function checkLinks(
  find: FindArtifact,
  artifactId: string | null,
  optionArtifacts: Record<string, string>,
  options: string[],
  sealed = false,
): void {
  // Worded to avoid "not found", which the HTTP layer reports as a 404.
  if (artifactId && !find(artifactId))
    throw new Error(`No artifact ${artifactId} in this session`);
  for (const [label, id] of Object.entries(optionArtifacts)) {
    if (!sealed && !options.includes(label))
      throw new Error(
        `optionArtifacts names "${label}", which is not an option`,
      );
    if (!find(id)) throw new Error(`No artifact ${id} in this session`);
  }
}

export interface BindingInput {
  type: QuestionView["type"];
  options: string[];
  artifactId: string | null;
  optionValues: Record<string, ControlValues>;
  control: string | null;
  unit: string | null;
  min?: number | null | undefined;
  max?: number | null | undefined;
}

/**
 * A question's binding: its artifact is html and declares every control,
 * and the controls suit the question type. Sealed, the option labels and
 * the artifact's markup can't be checked.
 */
export function checkBinding(
  find: FindArtifact,
  question: BindingInput,
  sealed = false,
): void {
  const controls = boundControls(question);
  if (!controls.length) {
    if (question.unit) throw new Error("unit needs a control to apply to");
    return;
  }
  if (!question.artifactId)
    throw new Error(
      "optionValues and control need artifactId: the html artifact they change",
    );
  const artifact = find(question.artifactId);
  if (!artifact)
    throw new Error(`No artifact ${question.artifactId} in this session`);
  if (artifact.format !== "html")
    throw new Error(
      `Artifact "${artifact.title}" is ${artifact.format}; only html artifacts have controls`,
    );
  const choices =
    question.type === "yes-no"
      ? ["Yes", "No"]
      : question.type === "single-choice" || question.type === "multiple-choice"
        ? question.options
        : null;
  if (choices) {
    if (question.control)
      throw new Error(
        "control is for number and text questions; give a choice optionValues",
      );
    if (!sealed)
      for (const label of Object.keys(question.optionValues))
        if (!choices.includes(label))
          throw new Error(
            `optionValues names "${label}", which is not an option`,
          );
  } else {
    if (Object.keys(question.optionValues).length)
      throw new Error("optionValues is for choice questions");
    const kind = controlKind(question.control!);
    if (question.type === "number" && kind !== "variable")
      throw new Error(
        `A number question sets a CSS variable such as --radius, not ${question.control}`,
      );
    if (
      question.type === "number" &&
      (question.min == null || question.max == null)
    )
      throw new Error(
        `A number question bound to ${question.control} needs min and max, for its slider`,
      );
    if (question.type === "text" && kind !== "text")
      throw new Error(
        `A text question sets a text slot such as #headline, not ${question.control}`,
      );
    if (question.type === "text" && question.unit)
      throw new Error("unit is for number questions");
  }
  if (sealed || artifact.content === undefined) return;
  const missing = missingControls(artifact.content, controls);
  if (missing.length) throw new Error(undeclared(artifact.title, missing));
}

/** Bound questions an edited artifact no longer serves, as warnings. */
export function bindingWarnings(
  questions: QuestionView[],
  artifact: ArtifactRef & { content: string },
): string[] {
  return questions
    .filter(
      (question) => question.artifactId === artifact.id && isBound(question),
    )
    .flatMap((question) => {
      const where = `Question "${question.prompt}"`;
      if (artifact.format !== "html")
        return [
          `${where} sets controls, but "${artifact.title}" is no longer html`,
        ];
      const missing = missingControls(
        artifact.content,
        boundControls(question),
      );
      return missing.length
        ? [`${where}: ${undeclared(artifact.title, missing)}`]
        : [];
    });
}

/**
 * What a batch's answers say beyond their text: whether the user took the
 * recommended default, and what each answer set in its artifact. The
 * service works these out for plain interviews; for an encrypted one it
 * sends each answer's question along, and the client finishes the batch.
 */
export interface BatchAnswer {
  answer: string | null;
  skipped: boolean;
  acceptedDefault?: boolean;
  applied?: { artifactId: string | null; values: ControlValues };
  /** Encrypted interviews only, until the client finishes the batch. */
  question?: QuestionView;
  [key: string]: unknown;
}

export function answerExtras(question: QuestionView) {
  return {
    acceptedDefault:
      !!question.answer &&
      !question.answer.skipped &&
      question.answer.text === defaultAnswerText(question),
    ...(isBound(question)
      ? {
          applied: {
            artifactId: question.artifactId,
            values: savedValues(question) ?? {},
          },
        }
      : {}),
  };
}

/** Works out each answer's extras from the question it carries, then drops it. */
export function completeBatch<T>(batch: T): T {
  const answers = (batch as { answers?: BatchAnswer[] } | null)?.answers;
  if (!Array.isArray(answers)) return batch;
  return {
    ...batch,
    answers: answers.map((item) => {
      if (!item.question) return item;
      const { question, ...rest } = item;
      return { ...rest, ...answerExtras(question) };
    }),
  };
}
