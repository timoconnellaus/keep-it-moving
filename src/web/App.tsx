import { useCallback, useEffect, useState } from "react";
import { defaultAnswerText } from "../shared/answers.js";
import type { SessionView } from "../shared/schema.js";
import { shownArtifact } from "../shared/workspace.js";
import { useOverview } from "./overview.js";
import { QuestionCard } from "./QuestionCard.js";
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
  const sessions = useOverview(overviewVersion);
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
        if (message.type === "overview")
          setOverviewVersion((value) => value + 1);
        if (message.type === "state" && message.session) {
          setSession(message.session);
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
    };
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
        />
      ))}
    </section>
  );
  const workspaceOpen = session.stageVisible && session.artifacts.length > 0;
  return (
    <main className={`shell ${workspaceOpen ? "with-workspace" : ""}`}>
      <header className="topbar">
        <Switcher session={session} sessions={sessions} />
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
    </main>
  );
}
