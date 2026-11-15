import { choicesFor, parseAnswer } from "./answers.js";
import type { QuestionView } from "./schema.js";

/**
 * A named value inside an html artifact that an answer can set, written
 * with a sigil for its kind:
 * - `--accent`: a CSS custom property, set on :root
 * - `@nav`: the `data-kim-nav` attribute on the root element, and on any
 *   other element whose markup carries it, for CSS such as
 *   `[data-kim-nav="top"] .sidebar { display: none }`
 * - `#headline`: the text of every `data-kim-text="headline"` element
 *
 * The applier (APPLIER_SOURCE in server/artifactView.ts) writes them and
 * fires `kim-change` on the window after each change.
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

/** The attribute's key in `element.dataset`: `@main-nav` is `kimMainNav`. */
export const datasetName = (control: Control) =>
  `kim-${control.slice(1)}`.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A script reading the attribute: through `dataset`, or by its name in quotes. */
const scriptReads = (control: Control) => {
  const key = escapeRegExp(datasetName(control));
  const attr = escapeRegExp(attributeName(control));
  return new RegExp(
    `dataset\\s*(?:\\.\\s*${key}(?![\\w$])|\\[\\s*["'\`]${key}["'\`]\\s*\\])|["'\`]${attr}["'\`]`,
  );
};

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
      return (
        new RegExp(`data-kim-${name}(?![\\w-])`).test(html) ||
        scriptReads(control).test(html)
      );
    case "text":
      return new RegExp(
        `data-kim-text\\s*=\\s*(["']?)${name}\\1(?![\\w-])`,
      ).test(html);
  }
}

export const missingControls = (html: string, controls: Control[]) =>
  controls.filter((control) => !declaresControl(html, control));

/** The `@attribute` and `#slot` controls an artifact's markup names. */
export function markupControls(html: string): Control[] {
  const found = new Set<Control>();
  for (const [, name] of html.matchAll(/data-kim-([a-z][a-z0-9-]*)(?![\w-])/g))
    if (name !== "text") found.add(`@${name}`);
  for (const [, , name] of html.matchAll(
    /data-kim-text\s*=\s*(["']?)([\w-]+)\1/g,
  ))
    found.add(`#${name}`);
  return [...found];
}

/** Each `<style>` block's CSS, comments removed. */
const styleSheets = (html: string) =>
  [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(([, css]) =>
    css!.replace(/\/\*[\s\S]*?\*\//g, ""),
  );

/** A selector list that includes the root element (`:root`, `html`, `html.dark`…). */
const selectsRoot = (selectors: string) =>
  selectors
    .split(",")
    .some((selector) =>
      /^(?::root|html)(?![\w-])[^\s>+~]*$/i.test(selector.trim()),
    );

/** Why setting a variable on :root wouldn't show, or null. */
function variableProblem(html: string, control: Control): string | null {
  const name = escapeRegExp(control);
  // A script that sets it itself may know what it's doing.
  if (new RegExp(`setProperty\\(\\s*["'\`]${name}["'\`]`).test(html))
    return null;
  const declares = new RegExp(`(?<![\\w-])${name}\\s*:`);
  let onRoot = false;
  const elsewhere: string[] = [];
  for (const css of styleSheets(html))
    for (const [, selectors, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g))
      if (declares.test(body!)) {
        if (selectsRoot(selectors!)) onRoot = true;
        else elsewhere.push(selectors!.trim().replace(/\s+/g, " "));
      }
  for (const [, tag, , style] of html.matchAll(
    /<([a-zA-Z][\w-]*)\b[^>]*?\sstyle\s*=\s*(["'])([^"']*)\2/g,
  ))
    if (declares.test(style!)) {
      if (tag!.toLowerCase() === "html") onRoot = true;
      else elsewhere.push(`<${tag!.toLowerCase()} style>`);
    }
  const wide = elsewhere.filter((selectors) =>
    selectors
      .split(",")
      .some((selector) => /^(?:body|\*|<body style>)$/i.test(selector.trim())),
  );
  const shadowing = wide.length ? wide : onRoot ? [] : elsewhere;
  if (!shadowing.length) return null;
  return `kim sets ${control} on the root element (:root), but it is also declared in ${shadowing
    .slice(0, 3)
    .map((selectors) => `"${selectors}"`)
    .join(
      ", ",
    )}, which wins inside that element, so an answer may not show. Declare its default in :root { ${control}: … } and override it lower down only where you mean to`;
}

/** Why setting an attribute wouldn't show, or null. */
function attributeProblem(html: string, control: Control): string | null {
  const attr = attributeName(control);
  const name = escapeRegExp(attr);
  const key = datasetName(control);
  const selected = new RegExp(`\\[\\s*${name}(?![\\w-])`).test(html);
  const scripted = scriptReads(control).test(html);
  if (!selected && !scripted)
    return `kim sets ${attr} on <html>, but no CSS selector or script reads it, so every value looks the same. Style each value, such as [${attr}="compact"] .card { padding: 8px }`;
  const hosts = [
    ...html.matchAll(
      new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*?\\s${name}(?![\\w-])`, "g"),
    ),
  ]
    .map(([, tag]) => tag!.toLowerCase())
    .filter((tag) => tag !== "html");
  const narrow = [
    ...html.matchAll(
      new RegExp(
        `(?<![\\w:.#-])([A-Za-z][\\w-]*|[.#][A-Za-z_][\\w-]*)\\[\\s*${name}(?![\\w-])`,
        "g",
      ),
    ),
  ]
    .map(([, head]) => head!)
    .filter((head) => head.toLowerCase() !== "html");
  if (narrow.length && !hosts.length)
    return `CSS such as ${narrow[0]}[${attr}…] needs that element to carry ${attr}, but kim sets it on <html> (and on elements whose markup has it). Write [${attr}="…"] …, or put ${attr} on that element in the markup`;
  if (
    new RegExp(
      `\\bbody\\s*\\.\\s*(?:dataset\\s*\\.\\s*${key}(?![\\w$])|getAttribute\\(\\s*["'\`]${name}["'\`])`,
    ).test(html) &&
    !hosts.includes("body")
  )
    return `a script reads ${attr} from <body>, but kim sets it on <html>. Read document.documentElement.dataset.${key}, or put ${attr} on <body> in the markup`;
  if (scripted && !selected && !/kim-change|MutationObserver/.test(html))
    return `only a script reads ${attr}, and nothing runs it again when an answer changes it. Redraw on kim's change event: window.addEventListener("kim-change", render)`;
  return null;
}

/** Why filling a text slot would break or not show, or null. */
function slotProblem(html: string, control: Control): string | null {
  const name = escapeRegExp(control.slice(1));
  const open = new RegExp(
    `<([a-zA-Z][\\w-]*)\\b[^>]*\\bdata-kim-text\\s*=\\s*(["']?)${name}\\2(?![\\w-])[^>]*>`,
    "g",
  );
  for (const match of html.matchAll(open)) {
    const rest = html.slice(match.index + match[0].length);
    if (!new RegExp(`^[^<]*</${match[1]}\\s*>`, "i").test(rest))
      return `a data-kim-text="${control.slice(1)}" <${match[1]!.toLowerCase()}> holds other elements; kim replaces its whole text, which removes them. Mark an element that holds only text`;
  }
  return null;
}

/**
 * Declared controls an answer would set without a visible effect, as
 * warnings: a variable a narrower declaration shadows, an attribute
 * nothing reads where kim writes it, or a text slot holding markup.
 * Controls the artifact doesn't declare are left to missingControls.
 */
export function controlWarnings(html: string, controls: Control[]): string[] {
  return controls.flatMap((control) => {
    if (!CONTROL_PATTERN.test(control) || !declaresControl(html, control))
      return [];
    const problem =
      controlKind(control) === "variable"
        ? variableProblem(html, control)
        : controlKind(control) === "attribute"
          ? attributeProblem(html, control)
          : slotProblem(html, control);
    return problem ? [`${control}: ${problem}`] : [];
  });
}

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
