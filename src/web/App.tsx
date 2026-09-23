import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import {
  NOTE_SEPARATOR,
  choicesFor,
  composeAnswer,
  defaultAnswerText,
  inOptionOrder,
} from "../shared/answers.js";
import type {
  ArtifactView,
  QuestionView,
  SessionView,
} from "../shared/schema.js";
import { shownArtifact } from "../shared/workspace.js";
import type { GeminiVoice } from "./gemini.js";
import { ArtifactThumb, Stage, type StageCapture } from "./Stage.js";

const token = window.location.pathname.split("/").filter(Boolean).at(-1) ?? "";

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState("");
  const [voiceState, setVoiceState] = useState<
    "off" | "connecting" | "listening" | "error"
  >("off");
  const voice = useRef<GeminiVoice | null>(null);
  const questionElements = useRef(new Map<string, HTMLElement>());
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [acceptingAll, setAcceptingAll] = useState(false);
  const [stageExpanded, setStageExpanded] = useState(false);
  const stageCapture = useRef<StageCapture | null>(null);
  const showArtifact = useCallback(async (artifactId: string) => {
    await fetch(`/api/browser/${token}/stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifactId }),
    });
  }, []);
  useEffect(() => {
    if (!stageExpanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setStageExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stageExpanded]);
  const onDirtyChange = useCallback((questionId: string, value: boolean) => {
    setDirty((current) => {
      if (current.has(questionId) === value) return current;
      const next = new Set(current);
      if (value) next.add(questionId);
      else next.delete(questionId);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/browser/${token}/session`);
    if (!response.ok) {
      setError("This interview is unavailable.");
      return;
    }
    const next = (await response.json()) as SessionView;
    setSession(next);
    voice.current?.updateSession(next);
  }, []);

  useEffect(() => {
    const disconnectedMessage =
      "Live updates disconnected. Reconnecting automatically…";
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connectStateSocket = () => {
      if (disposed) return;
      const nextSocket = new WebSocket(
        `${protocol}//${location.host}/ws/${token}`,
      );
      socket = nextSocket;
      nextSocket.onopen = () => {
        setError((current) => (current === disconnectedMessage ? "" : current));
        void refresh();
      };
      nextSocket.onmessage = (event) => {
        let message: { type: string; session?: SessionView };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch {
          setError(disconnectedMessage);
          nextSocket.close();
          return;
        }
        if (message.type === "state" && message.session) {
          setSession(message.session);
          voice.current?.updateSession(message.session);
        }
      };
      nextSocket.onerror = () => setError(disconnectedMessage);
      nextSocket.onclose = () => {
        if (disposed || socket !== nextSocket) return;
        setError(disconnectedMessage);
        reconnectTimer = setTimeout(connectStateSocket, 1_000);
      };
    };

    void refresh();
    connectStateSocket();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (
        socket?.readyState === WebSocket.CONNECTING ||
        socket?.readyState === WebSocket.OPEN
      )
        socket.close();
      void voice.current?.stop();
    };
  }, [refresh]);

  useEffect(() => {
    if (session?.focusSource === "gemini" && session.focusedQuestionId) {
      questionElements.current
        .get(session.focusedQuestionId)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [session?.focusSource, session?.focusedQuestionId]);

  const toggleVoice = async () => {
    if (!session || session.status !== "active") return;
    if (voice.current) {
      await voice.current.stop();
      voice.current = null;
      setVoiceState("off");
      return;
    }
    setVoiceState("connecting");
    const { GeminiVoice } = await import("./gemini.js");
    const instance = new GeminiVoice(token, session, {
      onState: setVoiceState,
      onError: setError,
      refresh: () => void refresh(),
      captureStage: async () => (await stageCapture.current?.()) ?? null,
    });
    voice.current = instance;
    if (!(await instance.start())) voice.current = null;
  };

  if (!session)
    return (
      <main className="shell">
        <p>{error || "Loading interview…"}</p>
      </main>
    );
  const unanswered = session.questions.find((question) => !question.answer)?.id;
  const focused = session.focusedQuestionId ?? unanswered;
  const active = session.status === "active";
  const done = session.questions.filter((question) => question.answer).length;
  const total = session.questions.length;
  // Questions whose form the user has touched keep their in-progress edits.
  const acceptable = session.questions.filter(
    (question) =>
      !question.answer && question.default && !dirty.has(question.id),
  );
  const acceptAll = async () => {
    setAcceptingAll(true);
    try {
      for (const question of acceptable) {
        const response = await fetch(
          `/api/browser/${token}/questions/${question.id}/answer`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ answer: defaultAnswerText(question) }),
          },
        );
        if (!response.ok) {
          setError(
            ((await response.json()) as { error?: string }).error ??
              "Could not accept defaults",
          );
          break;
        }
      }
    } finally {
      setAcceptingAll(false);
      await refresh();
    }
  };
  const shown = shownArtifact(session);
  const questions = (
    <section className="questions" aria-label="Interview questions">
      {session.questions.length === 0 && (
        <div className="empty">
          <h2>No questions yet</h2>
          <p>The interviewer will add the first question shortly.</p>
        </div>
      )}
      {session.questions.map((question, index) => (
        <QuestionCard
          key={question.id}
          token={token}
          question={question}
          number={index + 1}
          emphasized={question.id === focused}
          geminiFocused={
            session.focusSource === "gemini" &&
            session.focusedQuestionIds.includes(question.id)
          }
          geminiFocusLead={
            session.focusSource === "gemini" &&
            question.id === session.focusedQuestionId
          }
          disabled={!active || acceptingAll}
          elementRef={(element) => {
            if (element) questionElements.current.set(question.id, element);
            else questionElements.current.delete(question.id);
          }}
          onSaved={refresh}
          onDirtyChange={onDirtyChange}
          artifacts={session.artifacts}
          shownArtifactId={shown?.id ?? null}
          onShowArtifact={(id) => void showArtifact(id)}
        />
      ))}
    </section>
  );
  return (
    <main
      className={`shell ${session.artifacts.length ? "with-workspace" : ""}`}
    >
      <header className="topbar">
        <h1>{session.title}</h1>
        {total > 0 && (
          <span
            className="progress"
            aria-label={`${done} of ${total} questions done`}
          >
            <span className="progress-count">
              {done}/{total}
            </span>
            <span className="progress-bar" aria-hidden="true">
              <span style={{ width: `${(done / total) * 100}%` }} />
            </span>
          </span>
        )}
        {active && acceptable.length > 0 && (
          <button
            className="accept-all"
            type="button"
            disabled={acceptingAll}
            onClick={() => void acceptAll()}
            title="Save the default answer for every open question you haven't edited"
          >
            {acceptingAll
              ? "Accepting…"
              : `Accept ${acceptable.length} default${acceptable.length === 1 ? "" : "s"}`}
          </button>
        )}
        <button
          className={`mic ${voiceState}`}
          onClick={() => void toggleVoice()}
          disabled={!active || voiceState === "connecting"}
          aria-label={
            voiceState === "listening"
              ? "Stop voice conversation"
              : "Start voice conversation"
          }
          title={
            voiceState === "listening"
              ? "Stop voice conversation"
              : "Start voice conversation"
          }
        >
          <MicIcon active={voiceState === "listening"} />
        </button>
      </header>
      {error && (
        <div className="notice" role="status">
          {error}
        </div>
      )}
      {session.status === "stopped" && (
        <div className="notice stopped" role="status">
          This interview is finished. Answers are available to review.
        </div>
      )}
      {session.artifacts.length ? (
        <div className={`workspace ${stageExpanded ? "expanded" : ""}`}>
          <Stage
            token={token}
            session={session}
            expanded={stageExpanded}
            onShow={(id) => void showArtifact(id)}
            onToggleExpanded={() => setStageExpanded((value) => !value)}
            captureRef={stageCapture}
          />
          {questions}
        </div>
      ) : (
        questions
      )}
    </main>
  );
}

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

function QuestionCard({
  token,
  question,
  number,
  emphasized,
  geminiFocused,
  geminiFocusLead,
  disabled,
  elementRef,
  onSaved,
  onDirtyChange,
  artifacts,
  shownArtifactId,
  onShowArtifact,
}: {
  token: string;
  question: QuestionView;
  number: number;
  emphasized: boolean;
  geminiFocused: boolean;
  /** First question of the group voice is discussing; carries the label. */
  geminiFocusLead: boolean;
  disabled: boolean;
  elementRef(element: HTMLElement | null): void;
  onSaved(): Promise<void>;
  onDirtyChange(questionId: string, dirty: boolean): void;
  artifacts: ArtifactView[];
  shownArtifactId: string | null;
  onShowArtifact(artifactId: string): void;
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
      ref={elementRef}
      className={`question ${open ? "open" : ""} ${emphasized ? "emphasized" : ""} ${geminiFocused ? "gemini-focused" : ""} ${question.answer?.delivered ? "received" : ""}`}
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
        {geminiFocusLead && <span className="gemini-focus">Gemini</span>}
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
              aria-label="Saved locally"
              title="Saved locally"
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
function MicIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 1 0-7 0v5A3.5 3.5 0 0 0 12 15Z" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
      {active && <circle cx="19" cy="5" r="3" className="live-dot" />}
    </svg>
  );
}
