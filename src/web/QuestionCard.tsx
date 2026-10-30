import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import {
  choicesFor,
  composeAnswer,
  defaultAnswerText,
  inOptionOrder,
  parseAnswer,
} from "../shared/answers.js";
import {
  answerValues,
  isBound,
  type ControlValues,
} from "../shared/bindings.js";
import type {
  ArtifactView,
  DraftView,
  QuestionView,
} from "../shared/schema.js";
import { questionArtifacts } from "./canvasLayout.js";
import { ArtifactThumb } from "./frames.js";

function initialAnswerState(
  question: QuestionView,
  draft: DraftView | null,
): {
  selected: string[];
  note: string;
} {
  const choices = choicesFor(question);
  // The answer, else the assignee's agent's draft, else the default.
  const text =
    question.answer && !question.answer.skipped
      ? question.answer.text
      : !question.answer && draft && !draft.skipped
        ? draft.text
        : null;
  if (text !== null)
    return choices.length
      ? parseAnswer(choices, question.type === "multiple-choice", text)
      : { selected: [], note: text };
  if (draft) return { selected: [], note: "" };
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
  draft = null,
  number,
  total,
  emphasized,
  disabled,
  onSaved,
  onDirtyChange,
  artifacts,
  onShowArtifact,
  onShowOnCanvas,
  onFocusQuestion,
  onAsk,
  onPreview,
  onPoint,
  onSelection,
  comparing,
  onCompare,
  choose,
  valuesWith,
}: {
  token: string;
  question: QuestionView;
  /** The assignee's agent's draft, prefilled until they send it. */
  draft?: DraftView | null;
  number: number;
  /** How many questions the interview has, for "Question 2 of 5". */
  total: number;
  emphasized: boolean;
  disabled: boolean;
  onSaved(): Promise<void>;
  onDirtyChange(questionId: string, dirty: boolean): void;
  artifacts: ArtifactView[];
  /** Shows one option's artifact on the canvas. */
  onShowArtifact(artifactId: string): void;
  /** Shows the question's frames on the canvas. */
  onShowOnCanvas(): void;
  /** The user is working on this question. */
  onFocusQuestion(questionId: string): void;
  /** Opens the chat with this question attached; absent once stopped. */
  onAsk?: (() => void) | undefined;
  /** Shows unsaved control values in the question's artifact; null stops. */
  onPreview(questionId: string, values: ControlValues | null): void;
  /** The option under the pointer or keyboard focus; null when none is. */
  onPoint(questionId: string, option: string | null): void;
  /** The options chosen so far while the question is open; null once closed. */
  onSelection(questionId: string, selected: string[] | null): void;
  /** Whether the canvas shows a copy of the artifact per option. */
  comparing: boolean;
  /** Turns that comparison on or off; absent without a canvas. */
  onCompare?: (() => void) | undefined;
  /** An option chosen on the canvas ("Use …"), to pick here. */
  choose: { option: string; key: number } | null;
  /** An artifact's controls with this question's contribution replaced. */
  valuesWith(artifactId: string, values: ControlValues): ControlValues;
}) {
  const artifactFor = (id: string | null | undefined) =>
    id ? artifacts.find((artifact) => artifact.id === id) : undefined;
  const linked = artifactFor(question.artifactId);
  const initial = initialAnswerState(question, draft);
  const initialText = composeAnswer(initial.selected, initial.note);
  const [open, setOpen] = useState(!question.answer);
  const [selected, setSelected] = useState(initial.selected);
  const [note, setNote] = useState(initial.note);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  /** The option under the pointer or keyboard focus, previewed in the artifact. */
  const [hovered, setHovered] = useState<string | null>(null);
  const reset = () => {
    setSelected(initial.selected);
    setNote(initial.note);
  };
  const answerText = composeAnswer(selected, note);
  const dirty = answerText !== initialText;
  // What the form started from before this render: a form still showing
  // it is untouched, whatever the new starting point.
  const shownInitial = useRef(initialText);

  useChangeEffect(() => {
    if (question.answer) {
      reset();
      setOpen(false);
    }
  }, question.answer?.revision);
  // An agent edit to the default or options, or a new draft, refreshes an untouched form.
  useChangeEffect(() => {
    if (answerText === shownInitial.current) reset();
    shownInitial.current = initialText;
  }, initialText);
  useEffect(() => {
    onDirtyChange(question.id, open && dirty);
  }, [open, dirty]);
  useEffect(() => () => onDirtyChange(question.id, false), []);

  const choices = choicesFor(question);
  const multiple = question.type === "multiple-choice";
  // Answers that set controls inside the linked html artifact, live.
  const bound = isBound(question) && linked?.format === "html";
  const previewText = !open
    ? null
    : hovered !== null
      ? composeAnswer(
          multiple ? inOptionOrder(choices, [...selected, hovered]) : [hovered],
          "",
        )
      : dirty
        ? answerText
        : null;
  const preview =
    bound && previewText !== null
      ? (answerValues(question, previewText) ?? {})
      : null;
  const previewKey = JSON.stringify(preview);
  useEffect(() => {
    onPreview(question.id, preview);
  }, [previewKey]);
  useEffect(() => () => onPreview(question.id, null), []);
  useEffect(() => {
    onPoint(question.id, open ? hovered : null);
  }, [open, hovered]);
  useEffect(() => () => onPoint(question.id, null), []);
  const selectedKey = JSON.stringify(selected);
  useEffect(() => {
    onSelection(question.id, open ? selected : null);
  }, [open, selectedKey]);
  useEffect(() => () => onSelection(question.id, null), []);
  const hover = (option: string) => ({
    onMouseEnter: () => setHovered(option),
    onMouseLeave: () => setHovered(null),
    onFocus: () => setHovered(option),
    onBlur: () => setHovered(null),
  });
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
      // Closed once the saved answer is in, so a preview hands straight over to it.
      await onSaved();
      setOpen(false);
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
  const pick = (option: string) => {
    setHovered(null);
    setSelected((values) =>
      values.includes(option)
        ? values.filter((item) => item !== option)
        : multiple
          ? inOptionOrder(choices, [...values, option])
          : [option],
    );
  };
  useChangeEffect(() => {
    if (choose && open && !selected.includes(choose.option))
      pick(choose.option);
  }, choose?.key);
  const hint = question.type === "number" ? numberHint(question) : "";
  const onCanvas = questionArtifacts(question).some((id) => artifactFor(id));

  const done = question.answer !== null && !open;
  const actions = (
    <>
      {onCanvas && (
        <button
          type="button"
          className={`canvas-link ${emphasized ? "on-stage" : ""}`}
          onClick={onShowOnCanvas}
          title="Show this question's frames on the canvas"
        >
          On canvas
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
      onFocusCapture={open ? () => onFocusQuestion(question.id) : undefined}
      onMouseDown={open ? () => onFocusQuestion(question.id) : undefined}
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
      {open && draft && !question.answer && (
        <p className="draft-note">
          {draft.skipped
            ? "Your agent suggests skipping this"
            : dirty
              ? "Edited from your agent's draft"
              : "Drafted by your agent"}
        </p>
      )}
      {open && (
        <div className="answer-form">
          {choices.length > 0 &&
            (bound ||
            choices.some((option) =>
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
                        {...hover(option)}
                      >
                        {artifact ? (
                          <ArtifactThumb token={token} artifact={artifact} />
                        ) : (
                          bound && (
                            <ArtifactThumb
                              token={token}
                              artifact={linked}
                              values={valuesWith(
                                linked.id,
                                question.optionValues[option] ?? {},
                              )}
                            />
                          )
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
                          aria-label={`View ${option} on the canvas`}
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
                      {...hover(option)}
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
          {bound &&
            question.type === "number" &&
            question.min !== null &&
            question.max !== null && (
              <input
                type="range"
                className="control-slider"
                min={question.min}
                max={question.max}
                step={question.step ?? "any"}
                value={
                  Number.isFinite(parseFloat(note))
                    ? parseFloat(note)
                    : question.min
                }
                aria-label={`${question.prompt} (${question.control})`}
                onChange={(event) => setNote(event.target.value)}
              />
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
              {bound && choices.length > 0 && onCompare && (
                <button
                  className={`compare ${comparing ? "on" : ""}`}
                  type="button"
                  aria-pressed={comparing}
                  onClick={onCompare}
                >
                  {comparing ? "Hide comparison" : "Compare side by side"}
                </button>
              )}
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
