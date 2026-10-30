import { useCallback, useEffect, useRef, useState } from "react";
import { defaultAnswerText } from "../shared/answers.js";
import {
  artifactValues,
  isBound,
  type ControlValues,
} from "../shared/bindings.js";
import type { PinView, SessionView } from "../shared/schema.js";
import { Account } from "./Account.js";
import { Assign } from "./Assign.js";
import {
  Canvas,
  type Comparison,
  type FitRequest,
  type FrameHighlight,
  type PlacedPin,
} from "./Canvas.js";
import { questionArtifacts } from "./canvasLayout.js";
import { Chat, useChat } from "./Chat.js";
import { useOverview } from "./overview.js";
import { QuestionCard } from "./QuestionCard.js";
import { MoreBelow, QuestionProgress } from "./QuestionNav.js";
import { liveSocket, probeStatus, STOP_MESSAGES } from "./liveSocket.js";
import { Logo } from "./Logo.js";
import { Switcher } from "./Switcher.js";

const token = window.location.pathname.split("/").filter(Boolean).at(-1) ?? "";

/** An agent that left a quarter of an hour ago is no longer "working". */
const STALE_MS = 15 * 60_000;

/**
 * What the agent is doing, as far as the page can tell: replying to a chat
 * message it has picked up, or working on answers it has collected while it
 * isn't waiting on the interview. Null when it's waiting, or nothing says.
 */
function agentActivity(
  session: SessionView,
): { label: string; busy: boolean } | null {
  if (session.status !== "active") return null;
  const last = session.chat.at(-1);
  const times = [
    session.updatedAt,
    last?.createdAt,
    ...session.questions.map((question) => question.answer?.updatedAt),
  ]
    .map((time) => Date.parse(time ?? ""))
    .filter(Number.isFinite);
  const busy = times.length > 0 && Date.now() - Math.max(...times) < STALE_MS;
  if (last?.author === "user" && last.delivered)
    return busy
      ? { label: "Agent is replying…", busy }
      : { label: "Waiting on the agent", busy };
  if (session.agentWatching || session.questions.length === 0) return null;
  if (session.questions.every((question) => question.answer?.delivered))
    return busy
      ? { label: "Agent is working on your answers…", busy }
      : { label: "Waiting on the agent", busy };
  return null;
}

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [acceptingAll, setAcceptingAll] = useState(false);
  const [overviewVersion, setOverviewVersion] = useState(0);
  // Unsaved values a question shows in its artifact: a hovered option, a
  // dragged slider. Never sent anywhere; saving makes them the answer's.
  const [previews, setPreviews] = useState<Record<string, ControlValues>>({});
  const onPreview = useCallback(
    (questionId: string, values: ControlValues | null) =>
      setPreviews((current) => {
        if (
          JSON.stringify(current[questionId]) ===
          JSON.stringify(values ?? undefined)
        )
          return current;
        const next = { ...current };
        if (values) next[questionId] = values;
        else delete next[questionId];
        return next;
      }),
    [],
  );
  // What the canvas follows in the questions: the option under the
  // pointer, each open question's choice so far, the question in hand.
  const [pointed, setPointed] = useState<{
    questionId: string;
    option: string;
  } | null>(null);
  const onPoint = useCallback(
    (questionId: string, option: string | null) =>
      setPointed((current) =>
        option
          ? current?.questionId === questionId && current.option === option
            ? current
            : { questionId, option }
          : current?.questionId === questionId
            ? null
            : current,
      ),
    [],
  );
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const onSelection = useCallback(
    (questionId: string, selected: string[] | null) =>
      setSelections((current) => {
        if (
          JSON.stringify(current[questionId]) ===
          JSON.stringify(selected ?? undefined)
        )
          return current;
        const next = { ...current };
        if (selected) next[questionId] = selected;
        else delete next[questionId];
        return next;
      }),
    [],
  );
  const [localFocus, setLocalFocus] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [choose, setChoose] = useState<{
    questionId: string;
    option: string;
    key: number;
  } | null>(null);
  const [fit, setFit] = useState<FitRequest | null>(null);
  const fitTo = useCallback(
    (ids: string[]) =>
      setFit((current) => ({ ids, key: (current?.key ?? 0) + 1 })),
    [],
  );
  // An assignee sees this interview only, never the owner's list.
  const sessions = useOverview(
    session && !session.respondent ? overviewVersion : null,
  );
  const questionsRef = useRef<HTMLElement>(null);
  const chat = useChat();
  const setStageVisible = useCallback(async (visible: boolean) => {
    await fetch(`/api/browser/${token}/stage/visibility`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visible }),
    });
  }, []);
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
      // The Worker says why when it's in another account.
      const { error } = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setError(error ?? "This interview is unavailable.");
      return;
    }
    const next = (await response.json()) as SessionView;
    setSession(next);
  }, []);

  useEffect(() => {
    const disconnectedMessage =
      "Live updates disconnected. Reconnecting automatically…";
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    void refresh();
    return liveSocket({
      url: `${protocol}//${location.host}/ws/${token}`,
      probe: probeStatus(`/api/browser/${token}/session`),
      onOpen: () => {
        setError((current) => (current === disconnectedMessage ? "" : current));
        void refresh();
      },
      onMessage: (data) => {
        let message: { type: string; session?: SessionView };
        try {
          message = JSON.parse(data) as typeof message;
        } catch {
          return;
        }
        if (message.type === "overview")
          setOverviewVersion((value) => value + 1);
        if (message.type === "state" && message.session) {
          setSession(message.session);
        }
      },
      onDrop: () => setError(disconnectedMessage),
      onStop: (reason) => setError(STOP_MESSAGES[reason]),
    });
  }, [refresh]);

  // The agent's focus replaces the user's own; its "show" fits that frame.
  const agentFocus = session?.focusedQuestionId;
  useEffect(() => setLocalFocus(null), [agentFocus]);
  const unanswered = session?.questions.find(
    (question) => !question.answer,
  )?.id;
  const ownFocus = session?.questions.find(
    (question) => question.id === localFocus && !question.answer,
  )?.id;
  const focused = ownFocus ?? agentFocus ?? unanswered;
  const framesFor = (questionId: string | undefined): string[] => {
    if (!session) return [];
    const question = session.questions.find((item) => item.id === questionId);
    const ids = question
      ? questionArtifacts(question).filter((id) =>
          session.artifacts.some((artifact) => artifact.id === id),
        )
      : [];
    if (ids.length) return ids;
    const plan = session.artifacts.find((artifact) => artifact.kind === "plan");
    return plan ? [plan.id] : [];
  };
  const lastFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const was = lastFocus.current;
    lastFocus.current = focused;
    if (was !== undefined && focused !== was && focused) {
      const ids = framesFor(focused);
      if (ids.length) fitTo(ids);
    }
  }, [focused]);
  const staged = session?.stage?.artifactId;
  const lastStaged = useRef(staged);
  useEffect(() => {
    if (staged && lastStaged.current !== staged) fitTo([staged]);
    lastStaged.current = staged;
  }, [staged]);

  if (!session)
    return (
      <main className="shell">
        <div className="shell-message">
          <Logo size={28} />
          <p>{error || "Loading interview…"}</p>
          {error && <a href="/">Your interviews</a>}
        </div>
      </main>
    );
  const active = session.status === "active";
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
  const workspaceOpen = session.stageVisible && session.artifacts.length > 0;
  const showOnCanvas = (ids: string[]) => {
    if (!ids.length) return;
    fitTo(ids);
    if (!workspaceOpen) void setStageVisible(true);
  };
  const compareQuestion = session.questions.find(
    (question) =>
      question.id === compareId && !question.answer && isBound(question),
  );
  const compareArtifact = session.artifacts.find(
    (artifact) =>
      artifact.id === compareQuestion?.artifactId && artifact.format === "html",
  );
  const comparison: Comparison | null =
    compareQuestion && compareArtifact
      ? {
          question: compareQuestion,
          artifact: compareArtifact,
          selected: selections[compareQuestion.id] ?? [],
          valuesFor: (option) =>
            artifactValues(session.questions, compareArtifact.id, {
              ...previews,
              [compareQuestion.id]: compareQuestion.optionValues[option] ?? {},
            }),
          onUse: (option) =>
            setChoose((current) => ({
              questionId: compareQuestion.id,
              option,
              key: (current?.key ?? 0) + 1,
            })),
        }
      : null;
  const toggleCompare = (questionId: string) => {
    if (compareId === questionId) return setCompareId(null);
    setCompareId(questionId);
    const question = session.questions.find((item) => item.id === questionId);
    const options =
      question?.type === "yes-no" ? ["Yes", "No"] : (question?.options ?? []);
    showOnCanvas([
      ...framesFor(questionId),
      ...options.map((_, index) => `copy:${index}`),
    ]);
  };
  // How each frame stands out for the question in hand.
  const inHand = session.questions.find(
    (question) => question.id === focused && !question.answer,
  );
  const highlight = (artifactId: string): FrameHighlight => {
    const pointedAt = session.questions.find(
      (question) => question.id === pointed?.questionId,
    );
    const hot =
      (pointedAt &&
        pointed &&
        (pointedAt.optionArtifacts[pointed.option] === artifactId ||
          (isBound(pointedAt) && pointedAt.artifactId === artifactId))) ||
      (inHand &&
        isBound(inHand) &&
        (inHand.type === "text" || inHand.type === "number") &&
        inHand.artifactId === artifactId &&
        Boolean(previews[inHand.id]));
    const chosen = inHand ? (selections[inHand.id] ?? []) : [];
    const picked = Boolean(
      inHand &&
      chosen.some((option) => inHand.optionArtifacts[option] === artifactId),
    );
    const live =
      inHand &&
      isBound(inHand) &&
      inHand.artifactId === artifactId &&
      inHand.options.length > 0
        ? pointed?.questionId === inHand.id
          ? pointed.option
          : chosen.join(", ")
        : "";
    return {
      hot: Boolean(hot),
      picked,
      tag: picked
        ? { kind: "", text: "Selected" }
        : live
          ? { kind: "live", text: live }
          : null,
    };
  };
  const sentPins = session.chat.flatMap((message) =>
    message.pin ? [message.pin] : [],
  );
  const pins: PinView[] = chat.pin ? [...sentPins, chat.pin] : sentPins;
  const placePin = (pin: PlacedPin) =>
    chat.comment({
      artifactId: pin.artifactId,
      element: pin.element,
      selector: pin.selector,
      x: pin.x,
      y: pin.y,
      fx: pin.fx,
      fy: pin.fy,
      width: pin.width,
      n: Math.max(0, ...sentPins.map((sent) => sent.n)) + 1,
      title: pin.title,
    });
  const staging = session.stage?.artifactId;
  const initial = framesFor(focused).length
    ? framesFor(focused)
    : staging
      ? [staging]
      : [];
  const questions = (
    <section
      className="questions"
      aria-label="Interview questions"
      ref={questionsRef}
    >
      {session.questions.length === 0 && (
        <div className="empty">
          <h2>No questions yet</h2>
          <p>The agent will add the first question shortly.</p>
        </div>
      )}
      {session.questions.map((question, index) => (
        <QuestionCard
          key={question.id}
          token={token}
          question={question}
          number={index + 1}
          total={session.questions.length}
          emphasized={question.id === focused}
          disabled={!active || acceptingAll}
          onSaved={refresh}
          onDirtyChange={onDirtyChange}
          artifacts={session.artifacts}
          onShowArtifact={(id) => showOnCanvas([id])}
          onShowOnCanvas={() => {
            setLocalFocus(question.id);
            showOnCanvas(framesFor(question.id));
          }}
          onFocusQuestion={setLocalFocus}
          onAsk={active ? () => chat.ask(question.id) : undefined}
          onPreview={onPreview}
          onPoint={onPoint}
          onSelection={onSelection}
          comparing={comparison?.question.id === question.id}
          onCompare={
            session.artifacts.length > 0
              ? () => toggleCompare(question.id)
              : undefined
          }
          choose={choose?.questionId === question.id ? choose : null}
          valuesWith={(artifactId, values) =>
            artifactValues(session.questions, artifactId, {
              ...previews,
              [question.id]: values,
            })
          }
        />
      ))}
      <MoreBelow container={questionsRef} questions={session.questions} />
    </section>
  );
  const activity = agentActivity(session);
  return (
    <main className="shell">
      <header className="topbar">
        {session.respondent ? (
          <div className="respondent-title">
            <h1>{session.title}</h1>
            {session.assignedBy && <span>From {session.assignedBy}</span>}
          </div>
        ) : (
          <Switcher session={session} sessions={sessions} />
        )}
        {activity && (
          <span
            className={`agent-status ${activity.busy ? "busy" : ""}`}
            role="status"
          >
            {activity.label}
          </span>
        )}
        <span className="topbar-spacer" />
        <QuestionProgress questions={session.questions} />
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
        {session.artifacts.length > 0 && (
          <button
            className={`workspace-toggle ${workspaceOpen ? "on" : ""}`}
            type="button"
            aria-pressed={workspaceOpen}
            onClick={() => void setStageVisible(!workspaceOpen)}
            title={
              workspaceOpen
                ? "Hide the canvas of the plan and other workspace items"
                : "Show the canvas of the plan and other workspace items"
            }
          >
            Canvas
            <span className="count">{session.artifacts.length}</span>
          </button>
        )}
        {!session.respondent && (
          <Assign token={token} session={session} onChanged={refresh} />
        )}
        <Account />
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
      {/* Questions on the left, the workspace in the middle, the chat on the right. */}
      <div className={`workspace ${workspaceOpen ? "with-stage" : ""}`}>
        {questions}
        {workspaceOpen && (
          <Canvas
            token={token}
            session={session}
            valuesFor={(artifactId) =>
              artifactValues(session.questions, artifactId, previews)
            }
            highlight={highlight}
            compare={comparison}
            pins={pins}
            initial={fit?.ids ?? initial}
            fit={fit}
            onComment={placePin}
          />
        )}
        <Chat token={token} session={session} chat={chat} onSent={refresh} />
      </div>
    </main>
  );
}
