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
  total,
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
  /** How many questions the interview has, for "Question 2 of 5". */
  total: number;
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

  const done = question.answer !== null && !open;
  const actions = (
    <>
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
          className="ask"
          onClick={onAsk}
          aria-label="Ask about this"
          title="Ask the agent about this question"
        >
          <ChatIcon />
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
    </>
  );

  return (
    <article
      data-question-id={question.id}
      className={`question ${open ? "open" : ""} ${done ? "done" : ""} ${emphasized ? "emphasized" : ""} ${question.answer?.delivered ? "received" : ""}`}
    >
      {done && question.answer ? (
        <div className="question-heading">
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
              title={question.answer.delivered ? "Sent to the agent" : "Saved"}
            >
              <TickIcon />
            </span>
          )}
          <h2>{question.prompt}</h2>
          <span
            className={`answer-summary ${question.answer.skipped ? "skipped" : ""}`}
            title={question.answer.skipped ? undefined : question.answer.text}
          >
            <span className="answer-text">
              {question.answer.skipped ? "Skipped" : question.answer.text}
            </span>
            {!question.answer.skipped &&
              question.answer.text === defaultText && (
                <span className="tag">default</span>
              )}
            {question.answer.answeredBy && (
              <span className="tag">by {question.answer.answeredBy}</span>
            )}
          </span>
          {/* Over the end of the row on hover or focus, so the answer gets the room. */}
          <span className="row-actions">{actions}</span>
        </div>
      ) : (
        <>
          <div className="question-meta">
            <span className="number">
              Question {number} of {total}
            </span>
            {actions}
          </div>
          <h2>{question.prompt}</h2>
        </>
      )}
      {open && (
        <div className="answer-form">
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
                            <span className="default-mark">Recommended</span>
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
                className={`choices ${multiple ? "multiple" : ""}`}
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
                      <span className="choice-mark" aria-hidden="true" />
                      <span className="choice-label">{option}</span>
                      {isDefaultOption && (
                        <span className="default-mark">Recommended</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          {question.recommendation && (
            <Recommendation markdown={question.recommendation} />
          )}
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
                className={`submit ${isDefault ? "accept" : ""}`}
                type="button"
                disabled={!canSave}
                onClick={submit}
              >
                {saving ? "Saving…" : isDefault ? "Accept default" : "Save"}
              </button>
              <button
                className="skip"
                type="button"
                disabled={saving || disabled}
                onClick={() => void save("", true)}
              >
                Skip
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

const icon = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
function TickIcon() {
  return (
    <svg {...icon} width="10" height="10" strokeWidth="2.4">
      <path d="M3.5 8.3 6.6 11.4 12.5 5" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg {...icon} width="15" height="15" strokeWidth="1.6">
      <path d="M3 3.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5H3A1.5 1.5 0 0 1 1.5 11V5A1.5 1.5 0 0 1 3 3.5z" />
      <path d="M6.5 6.6a1.6 1.6 0 1 1 2.2 1.5c-.5.2-.7.5-.7 1M8 10.6v.1" />
    </svg>
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
