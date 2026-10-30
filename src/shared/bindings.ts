import { choicesFor, parseAnswer } from "./answers.js";
import type { QuestionView } from "./schema.js";

/**
 * A named value inside an html artifact that an answer can set, written
 * with a sigil for its kind:
 * - `--accent`: a CSS custom property, set on :root
 * - `@nav`: the `data-kim-nav` attribute on the root element, for CSS
 *   such as `[data-kim-nav="top"] .sidebar { display: none }`
 * - `#headline`: the text of every `data-kim-text="headline"` element
 */
export type Control = string;
/** Control → value, such as `{ "--font-display": "Fraunces, serif" }`. */
export type ControlValues = Record<Control, string>;
export type ControlKind = "variable" | "attribute" | "text";

export const CONTROL_PATTERN = /^(--[A-Za-z_][\w-]*|@[a-z][a-z0-9-]*|#[\w-]+)$/;
/** CSS units a number binding may append, or none. */
export const UNIT_PATTERN = /^(%|[a-z]{1,5})?$/;

export function controlKind(control: Control): ControlKind {
  if (control.startsWith("--")) return "variable";
  if (control.startsWith("@")) return "attribute";
  return "text";
}

/** The attribute an `@name` control sets. */
export const attributeName = (control: Control) =>
  `data-kim-${control.slice(1)}`;

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether the artifact names a control, so an answer to it shows: a
 * variable it defines or reads with var(), an attribute its markup or CSS
 * mentions, or an element marked as the text slot.
 */
export function declaresControl(html: string, control: Control): boolean {
  const name = escapeRegExp(control.slice(control.startsWith("--") ? 2 : 1));
  switch (controlKind(control)) {
    case "variable":
      return new RegExp(`--${name}\\s*:|var\\(\\s*--${name}\\s*[,)]`).test(
        html,
      );
    case "attribute":
      return new RegExp(`data-kim-${name}(?![\\w-])`).test(html);
    case "text":
      return new RegExp(
        `data-kim-text\\s*=\\s*(["']?)${name}\\1(?![\\w-])`,
      ).test(html);
  }
}

export const missingControls = (html: string, controls: Control[]) =>
  controls.filter((control) => !declaresControl(html, control));

/** Every control a question's binding sets. */
export function boundControls(question: {
  optionValues: Record<string, ControlValues>;
  control: Control | null;
}): Control[] {
  const controls = new Set<Control>(
    Object.values(question.optionValues).flatMap(Object.keys),
  );
  if (question.control) controls.add(question.control);
  return [...controls];
}

export const isBound = (question: QuestionView) =>
  question.artifactId !== null && boundControls(question).length > 0;

const LEADING_NUMBER = /^\s*(-?(?:\d+\.?\d*|\.\d+))/;

/**
 * The values an answer sets in its question's artifact: the chosen options'
 * values merged in option order, a number with its unit, or the text.
 * Null when the answer sets nothing, such as a skip or a bare note.
 */
export function answerValues(
  question: QuestionView,
  text: string,
): ControlValues | null {
  if (!question.artifactId) return null;
  const choices = choicesFor(question);
  if (choices.length) {
    const { selected } = parseAnswer(
      choices,
      question.type === "multiple-choice",
      text,
    );
    const values = Object.assign(
      {},
      ...selected.map((option) => question.optionValues[option] ?? {}),
    ) as ControlValues;
    return Object.keys(values).length ? values : null;
  }
  if (!question.control) return null;
  if (question.type === "number") {
    const number = LEADING_NUMBER.exec(text)?.[1];
    return number === undefined
      ? null
      : { [question.control]: `${Number(number)}${question.unit ?? ""}` };
  }
  return text.trim() ? { [question.control]: text.trim() } : null;
}

/** What a saved answer applies; skipped and unanswered questions apply nothing. */
export function savedValues(question: QuestionView): ControlValues | null {
  return question.answer && !question.answer.skipped
    ? answerValues(question, question.answer.text)
    : null;
}

/**
 * The state of an artifact: each bound question's values in question
 * order, so a later question wins a shared control. A question in
 * `previews` contributes its unsaved values instead of its answer's.
 */
export function artifactValues(
  questions: QuestionView[],
  artifactId: string,
  previews: Record<string, ControlValues | null> = {},
): ControlValues {
  const values: ControlValues = {};
  for (const question of questions)
    if (question.artifactId === artifactId)
      Object.assign(values, previews[question.id] ?? savedValues(question));
  return values;
}
