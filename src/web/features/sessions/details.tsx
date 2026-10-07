import { useCallback, useEffect, useState } from "react";
import type { InboxItem } from "../../../shared/inbox.js";
import type { SessionView } from "../../../shared/schema.js";
import { QuestionCard } from "../../QuestionCard.js";
import { useLive } from "../shell/live.js";

/**
 * A request's questions, answered inline with the interview page's own
 * widgets. Answering the last one takes the item out of the inbox.
 */
export function RequestDetail({ item }: { item: InboxItem }) {
  const token = String(item.data?.token ?? "");
  const live = useLive();
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/browser/${token}/session`).catch(
      () => null,
    );
    if (!response?.ok) return setError("This request is unavailable.");
    setSession((await response.json()) as SessionView);
  }, [token]);
  useEffect(() => {
    void refresh();
  }, [refresh, live]);

  if (!session)
    return <p className="kim-sessions-quiet">{error || "Loading…"}</p>;
  const firstOpen = session.questions.find((question) => !question.answer);
  return (
    <div className="kim-sessions-request-detail">
      {session.questions.map((question, index) => (
        <QuestionCard
          key={question.id}
          token={token}
          question={question}
          number={index + 1}
          emphasized={question.id === firstOpen?.id}
          disabled={session.status !== "active"}
          onSaved={refresh}
          onDirtyChange={() => undefined}
          artifacts={session.artifacts}
          shownArtifactId={null}
          onShowArtifact={() => window.open(`/s/${token}`, "_blank")}
        />
      ))}
      <a className="kim-sessions-open" href={`/s/${token}`}>
        Open the full request
        {session.artifacts.length
          ? ` (${session.artifacts.length} in its workspace)`
          : ""}{" "}
        →
      </a>
    </div>
  );
}

/** An agent session waiting on Tim: its last message and where it runs. */
export function NeedsYouDetail({ item }: { item: InboxItem }) {
  const data = (item.data ?? {}) as Record<string, string | null>;
  const facts: Array<[string, string | null | undefined]> = [
    [
      "Location",
      data.location === "cloud" ? "Cloud" : data.location && "Local",
    ],
    ["Branch", data.branch],
    ["Machine", data.machine],
    ["Worktree", data.worktree],
  ];
  return (
    <div className="kim-sessions-needs">
      {data.message && data.message !== item.brief && (
        <div className="kim-sessions-message">
          <div className="kim-sessions-label">Last message</div>
          {data.message}
        </div>
      )}
      <dl className="kim-sessions-facts">
        {facts
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {data.prUrl && (
        <a className="kim-sessions-open" href={data.prUrl}>
          Open its pull request →
        </a>
      )}
    </div>
  );
}
