import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import {
  NOTE_SEPARATOR,
  choicesFor,
  composeAnswer,
  defaultAnswerText,
  inOptionOrder,
} from "../shared/answers.js";
import type { ArtifactView, QuestionView } from "../shared/schema.js";
import { ArtifactThumb } from "./Stage.js";

/** Inverse of composeAnswer; anything it cannot attribute to options becomes the note. */
function parseAnswer(
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

function initialAnswerState(question: QuestionView): {
  selected: string[];
  note: string;
} {
  const choices = choicesFor(question);
  if (question.answer && !question.answer.skipped)
    return choices.length
      ? parseAnswer(
          choices,
          question.type === "multiple-choice",
          question.answer.text,
        )
      : { selected: [], note: question.answer.text };
  if (!question.default) return { selected: [], note: "" };
  return choices.length
    ? { selected: inOptionOrder(choices, question.default), note: "" }
    : { selected: [], note: question.default[0]! };
}

function numberHint(question: QuestionView): string {
  const { min, max } = question;
  if (min !== null && max !== null) return `${min}–${max}`;
  if (min !== null) return `≥ ${min}`;
  if (max !== null) return `≤ ${max}`;
  return "";
}

/** One question and its answer widgets. */
export function QuestionCard({
  token,
  question,
  number,
  emphasized,
  disabled,
  onSaved,
  onDirtyChange,
  artifacts,
  shownArtifactId,
  onShowArtifact,
  onAsk,
}: {
  token: string;
  question: QuestionView;
  number: number;
  emphasized: boolean;
  disabled: boolean;
  onSaved(): Promise<void>;
  onDirtyChange(questionId: string, dirty: boolean): void;
  artifacts: ArtifactView[];
  shownArtifactId: string | null;
  onShowArtifact(artifactId: string): void;
  /** Opens the chat with this question attached; absent once stopped. */
  onAsk?: (() => void) | undefined;
}) {
  const artifactFor = (id: string | null | undefined) =>
    id ? artifacts.find((artifact) => artifact.id === id) : undefined;
  const linked = artifactFor(question.artifactId);
  const initial = initialAnswerState(question);
  const initialText = composeAnswer(initial.selected, initial.note);
  const [open, setOpen] = useState(!question.answer);
  const [selected, setSelected] = useState(initial.selected);
  const [note, setNote] = useState(initial.note);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const reset = () => {
    setSelected(initial.selected);
    setNote(initial.note);
  };
  const answerText = composeAnswer(selected, note);
  const dirty = answerText !== initialText;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useChangeEffect(() => {
    if (question.answer) {
      reset();
      setOpen(false);
    }
  }, question.answer?.revision);
  // An agent edit to the default or options refreshes an untouched form.
  useChangeEffect(() => {
    if (!dirtyRef.current) reset();
  }, initialText);
  useEffect(() => {
    onDirtyChange(question.id, open && dirty);
  }, [open, dirty]);
  useEffect(() => () => onDirtyChange(question.id, false), []);

  const choices = choicesFor(question);
  const multiple = question.type === "multiple-choice";
  const defaultText = defaultAnswerText(question);
  const isDefault = defaultText !== null && answerText === defaultText;
  const save = async (answer: string, skipped = false) => {
    setSaving(true);
    setSaveError("");
    try {
      const response = await fetch(
        `/api/browser/${token}/questions/${question.id}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer, skipped }),
        },
      );
      if (!response.ok)
        throw new Error(
          ((await response.json()) as { error?: string }).error ??
            "Could not save answer",
        );
      setOpen(false);
      await onSaved();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  const canSave = !saving && !disabled && answerText.length > 0;
  const submit = () => {
    if (canSave) void save(answerText);
  };
  const pick = (option: string) =>
    setSelected((values) =>
      values.includes(option)
        ? values.filter((item) => item !== option)
        : multiple
          ? inOptionOrder(choices, [...values, option])
          : [option],
    );
  const hint = question.type === "number" ? numberHint(question) : "";

  return (
    <article
      data-question-id={question.id}
      className={`question ${open ? "open" : ""} ${emphasized ? "emphasized" : ""} ${question.answer?.delivered ? "received" : ""}`}
    >
      <div className="question-heading">
        <span className="number">{String(number).padStart(2, "0")}</span>
        <h2>{question.prompt}</h2>
        {linked && (
          <button
            type="button"
            className={`artifact-link ${linked.id === shownArtifactId ? "on-stage" : ""}`}
            onClick={() => onShowArtifact(linked.id)}
            title="Show in the workspace"
          >
            {linked.title}
          </button>
        )}
        {onAsk && (
          <button
            type="button"
            className="edit ask"
            onClick={onAsk}
            title="Ask the agent about this question"
          >
            Ask about this
          </button>
        )}
        {question.answer && (
          <button
            className="edit"
            onClick={() => {
              if (open) reset();
              setOpen((value) => !value);
            }}
            disabled={disabled}
          >
            {open ? "Cancel" : "Edit"}
          </button>
        )}
      </div>
      {question.answer && !open && (
        <div
          className={`answer-summary ${question.answer.skipped ? "skipped" : ""}`}
        >
          {question.answer.skipped ? (
            <span
              className="status-icon skip-icon"
              aria-label="Skipped"
              title="Skipped"
            >
              –
            </span>
          ) : (
            <span
              className="status-icon saved"
              aria-label="Saved"
              title="Saved"
            >
              ✓
            </span>
          )}
          <span className="answer-text">
            {question.answer.skipped ? "Skipped" : question.answer.text}
          </span>
          {!question.answer.skipped && question.answer.text === defaultText && (
            <span className="tag">default</span>
          )}
          {question.answer.answeredBy && (
            <span className="tag">by {question.answer.answeredBy}</span>
          )}
        </div>
      )}
      {open && (
        <div className="answer-form">
          {question.recommendation && (
            <Recommendation markdown={question.recommendation} />
          )}
          {choices.length > 0 &&
            (choices.some((option) =>
              artifactFor(question.optionArtifacts[option]),
            ) ? (
              <div
                className="choice-cards"
                role="group"
                aria-label={multiple ? "Choose any" : "Choose one"}
              >
                {choices.map((option) => {
                  const artifact = artifactFor(
                    question.optionArtifacts[option],
                  );
                  const isDefaultOption = question.default?.includes(option);
                  return (
                    <div
                      key={option}
                      className={`choice-card ${selected.includes(option) ? "selected" : ""} ${isDefaultOption ? "is-default" : ""}`}
                    >
                      <button
                        type="button"
                        className="choice-card-pick"
                        onClick={() => pick(option)}
                        aria-pressed={selected.includes(option)}
                      >
                        {artifact && (
                          <ArtifactThumb token={token} artifact={artifact} />
                        )}
                        <span className="choice-card-label">
                          {option}
                          {isDefaultOption && (
                            <span className="default-mark">default</span>
                          )}
                        </span>
                      </button>
                      {artifact && (
                        <button
                          type="button"
                          className="choice-card-view"
                          onClick={() => onShowArtifact(artifact.id)}
                          aria-label={`View ${option} in the workspace`}
                        >
                          View
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                className="choices"
                role="group"
                aria-label={multiple ? "Choose any" : "Choose one"}
              >
                {choices.map((option) => {
                  const isDefaultOption = question.default?.includes(option);
                  return (
                    <button
                      key={option}
                      className={`${selected.includes(option) ? "selected" : ""} ${isDefaultOption ? "is-default" : ""}`}
                      onClick={() => pick(option)}
                      type="button"
                      aria-pressed={selected.includes(option)}
                    >
                      {option}
                      {isDefaultOption && (
                        <span className="default-mark">default</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          <div className="answer-row">
            {question.type === "text" ? (
              <textarea
                rows={2}
                value={note}
                placeholder="Type your answer… (⌘↵ to save)"
                aria-label="Your answer"
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                    submit();
                }}
              />
            ) : (
              <input
                type="text"
                inputMode={question.type === "number" ? "decimal" : undefined}
                className={question.type === "number" ? "number-input" : ""}
                value={note}
                placeholder={
                  question.type === "number"
                    ? `Number${hint ? ` (${hint})` : ""} or a note`
                    : "Other, or add a note…"
                }
                aria-label={
                  question.type === "number"
                    ? "Your answer"
                    : "Other answer or note"
                }
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit();
                }}
              />
            )}
            <div className="actions">
              <button
                className="skip"
                type="button"
                disabled={saving || disabled}
                onClick={() => void save("", true)}
              >
                Skip
              </button>
              <button
                className={`submit ${isDefault ? "accept" : ""}`}
                type="button"
                disabled={!canSave}
                onClick={submit}
              >
                {saving ? "Saving…" : isDefault ? "Accept default" : "Save"}
              </button>
            </div>
          </div>
          {saveError && (
            <p className="save-error" role="alert">
              {saveError}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Runs when `value` changes, but not on mount: state already starts from the
 * initial value, and a mount-time reset would undo a click made before
 * effects flush.
 */
function useChangeEffect(effect: () => void, value: unknown): void {
  const previous = useRef(value);
  useEffect(() => {
    if (Object.is(previous.current, value)) return;
    previous.current = value;
    effect();
  }, [value]);
}

function Recommendation({ markdown }: { markdown: string }) {
  return (
    <div className="recommendation">
      <span aria-hidden="true">→</span>
      <div className="markdown">
        <Markdown>{markdown}</Markdown>
      </div>
    </div>
  );
}
