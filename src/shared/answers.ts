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

/** Inverse of composeAnswer; anything it cannot attribute to options becomes the note. */
export function parseAnswer(
  choices: string[],
  multiple: boolean,
  text: string,
): { selected: string[]; note: string } {
  const byLength = [...choices].sort((a, b) => b.length - a.length);
  const selected: string[] = [];
  let rest = text;
  for (;;) {
    const match = byLength.find(
      (option) => !selected.includes(option) && rest.startsWith(option),
    );
    if (!match) break;
    const after = rest.slice(match.length);
    if (after === "") return { selected: [...selected, match], note: "" };
    if (after.startsWith(NOTE_SEPARATOR))
      return {
        selected: [...selected, match],
        note: after.slice(NOTE_SEPARATOR.length),
      };
    if (!multiple || !after.startsWith(", ")) break;
    selected.push(match);
    rest = after.slice(2);
  }
  return { selected: [], note: text };
}

/** The answer text that accepting a question's default submits. */
export function defaultAnswerText(question: QuestionView): string | null {
  if (!question.default) return null;
  const choices = choicesFor(question);
  return choices.length
    ? composeAnswer(inOptionOrder(choices, question.default), "")
    : question.default[0]!;
}

/** An answer as an agent gives it: words, chosen options, a note, or a skip. */
export interface AnswerParts {
  answer?: string | undefined;
  options?: string[] | undefined;
  note?: string | undefined;
  skipped?: boolean | undefined;
}

/**
 * The answer text the browser's form would send for these parts, checked
 * against the question as its form checks it: options must be the
 * question's, a number a number in range, and a note goes only where the
 * form has an "Other, or add a note" field.
 */
export function composeParts(
  question: QuestionView,
  parts: AnswerParts,
): { answer: string; skipped: boolean } {
  const text = parts.answer?.trim() ?? "";
  const note = parts.note?.trim() ?? "";
  const options = parts.options ?? [];
  if (parts.skipped) {
    if (text || note || options.length)
      throw new Error("A skip takes no answer, options or note");
    return { answer: "", skipped: true };
  }
  const choices = choicesFor(question);
  if (!choices.length) {
    if (options.length || note)
      throw new Error(
        `A ${question.type} question has no options or note; give the answer itself`,
      );
    if (!text)
      throw new Error("An answer is required unless the question is skipped");
    if (question.type === "number") {
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error(`"${text}" isn't a number`);
      if (question.min !== null && value < question.min)
        throw new Error(`${value} is below the minimum, ${question.min}`);
      if (question.max !== null && value > question.max)
        throw new Error(`${value} is above the maximum, ${question.max}`);
    }
    return { answer: text, skipped: false };
  }
  const named = [...options, ...(text ? [text] : [])];
  const selected = named.map((value) => {
    const match = choices.find(
      (choice) => choice.trim().toLowerCase() === value.trim().toLowerCase(),
    );
    if (!match)
      throw new Error(
        `"${value}" is not one of the options: ${choices.join(", ")}. Anything else goes in the note`,
      );
    return match;
  });
  if (question.type !== "multiple-choice" && new Set(selected).size > 1)
    throw new Error(`A ${question.type} question takes one option`);
  if (!selected.length && !note)
    throw new Error(`Choose one of: ${choices.join(", ")}, or give a note`);
  return {
    answer: composeAnswer(inOptionOrder(choices, selected), note),
    skipped: false,
  };
}
