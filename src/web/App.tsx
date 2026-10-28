import { useCallback, useEffect, useRef, useState } from "react";
import { defaultAnswerText } from "../shared/answers.js";
import type { SessionView } from "../shared/schema.js";
import { shownArtifact } from "../shared/workspace.js";
import { Assign } from "./Assign.js";
import { Chat, useChat } from "./Chat.js";
import { useOverview } from "./overview.js";
import { QuestionCard } from "./QuestionCard.js";
import { MoreBelow, QuestionProgress } from "./QuestionNav.js";
import { liveSocket, probeStatus, STOP_MESSAGES } from "./liveSocket.js";
import { Stage } from "./Stage.js";
import { Switcher } from "./Switcher.js";

const token = window.location.pathname.split("/").filter(Boolean).at(-1) ?? "";

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [acceptingAll, setAcceptingAll] = useState(false);
  const [stageExpanded, setStageExpanded] = useState(false);
  const [overviewVersion, setOverviewVersion] = useState(0);
  // An assignee sees this interview only, never the owner's list.
  const sessions = useOverview(
    session && !session.respondent ? overviewVersion : null,
  );
  const questionsRef = useRef<HTMLElement>(null);
  const chat = useChat();
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
  const setStageVisible = useCallback(async (visible: boolean) => {
    if (!visible) setStageExpanded(false);
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
      setError("This interview is unavailable.");
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

  if (!session)
    return (
      <main className="shell">
        <p>{error || "Loading interview…"}</p>
      </main>
    );
  const unanswered = session.questions.find((question) => !question.answer)?.id;
  const focused = session.focusedQuestionId ?? unanswered;
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
  const shown = shownArtifact(session);
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
          emphasized={question.id === focused}
          disabled={!active || acceptingAll}
          onSaved={refresh}
          onDirtyChange={onDirtyChange}
          artifacts={session.artifacts}
          shownArtifactId={shown?.id ?? null}
          onShowArtifact={(id) => {
            void showArtifact(id);
            if (!session.stageVisible) void setStageVisible(true);
          }}
          onAsk={active ? () => chat.ask(question.id) : undefined}
        />
      ))}
      <MoreBelow container={questionsRef} questions={session.questions} />
    </section>
  );
  const workspaceOpen = session.stageVisible && session.artifacts.length > 0;
  return (
    <main
      className={`shell ${workspaceOpen ? "with-workspace" : ""} ${chat.open ? "chat-open" : ""}`}
    >
      <header className="topbar">
        {session.respondent ? (
          <div className="respondent-title">
            <h1>{session.title}</h1>
            {session.assignedBy && <span>From {session.assignedBy}</span>}
          </div>
        ) : (
          <Switcher session={session} sessions={sessions} />
        )}
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
                ? "Hide the plan and other workspace items"
                : "Show the plan and other workspace items"
            }
          >
            Workspace
            <span className="count">{session.artifacts.length}</span>
          </button>
        )}
        {!session.respondent && (
          <Assign token={token} session={session} onChanged={refresh} />
        )}
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
      {workspaceOpen ? (
        <div className={`workspace ${stageExpanded ? "expanded" : ""}`}>
          <Stage
            token={token}
            session={session}
            expanded={stageExpanded}
            onShow={(id) => void showArtifact(id)}
            onToggleExpanded={() => setStageExpanded((value) => !value)}
            onClose={() => void setStageVisible(false)}
          />
          {questions}
        </div>
      ) : (
        questions
      )}
      <Chat token={token} session={session} chat={chat} onSent={refresh} />
    </main>
  );
}
