import type { QuestionView } from "./schema.js";

/** Separates chosen options from a typed note in a composed answer. */
export const NOTE_SEPARATOR = " — ";

export function choicesFor(question: QuestionView): string[] {
  if (question.type === "yes-no") return ["Yes", "No"];
  if (question.type === "single-choice" || question.type === "multiple-choice")
    return question.options;
  return [];
}

/** Keeps selections in option order so equal choices compose to equal answers. */
export function inOptionOrder(choices: string[], values: string[]): string[] {
  return choices.filter((choice) => values.includes(choice));
}

export function composeAnswer(selected: string[], note: string): string {
  return [selected.join(", "), note.trim()]
    .filter(Boolean)
    .join(NOTE_SEPARATOR);
}

/** The answer text that accepting a question's default submits. */
export function defaultAnswerText(question: QuestionView): string | null {
  if (!question.default) return null;
  const choices = choicesFor(question);
  return choices.length
    ? composeAnswer(inOptionOrder(choices, question.default), "")
    : question.default[0]!;
}
