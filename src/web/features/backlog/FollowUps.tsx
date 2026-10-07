import { useEffect, useRef, useState } from "react";
import type { InboxItem } from "../../../shared/inbox.js";
import {
  backlogChanged,
  copyText,
  followUpAction,
  useFollowUps,
  type FollowUpAction,
} from "./api.js";

/** What a row needs; the inbox item's data carries the same fields. */
export interface FollowUpRow {
  id: string;
  text: string;
}

/** How long "copied" shows before a started follow-up leaves the list. */
const COPIED_MS = 1500;

/**
 * Follow-up triage rows: To backlog, Start (copies a `claude` command) and
 * Dismiss. A row leaves the list once decided; `onDecided` hears about it.
 */
export function FollowUpRows({
  followUps,
  projectId,
  onDecided,
}: {
  followUps: FollowUpRow[];
  projectId: string | null;
  onDecided: (id: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const act = async (row: FollowUpRow, action: FollowUpAction) => {
    setBusy(row.id);
    try {
      const { command } = await followUpAction(row.id, action);
      if (projectId) backlogChanged(projectId);
      if (command) {
        const ok = await copyText(command);
        // Without clipboard access, the command stays up to copy by hand.
        setNotes((all) => ({ ...all, [row.id]: ok ? "copied" : command }));
        if (ok)
          timers.current.push(setTimeout(() => onDecided(row.id), COPIED_MS));
      } else onDecided(row.id);
    } catch (error) {
      setNotes((all) => ({
        ...all,
        [row.id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <ul className="kim-backlog-list">
      {followUps.map((row) => (
        <li key={row.id} className="kim-backlog-followup">
          <span className="kim-backlog-followup-text">{row.text}</span>
          <span className="kim-backlog-actions">
            <button
              type="button"
              disabled={busy === row.id}
              onClick={() => void act(row, "accept")}
            >
              To backlog
            </button>
            <button
              type="button"
              disabled={busy === row.id}
              onClick={() => void act(row, "start")}
            >
              {notes[row.id] === "copied" ? "Copied" : "Start"}
            </button>
            <button
              type="button"
              aria-label={`Dismiss follow-up: ${row.text}`}
              disabled={busy === row.id}
              onClick={() => void act(row, "dismiss")}
            >
              ✕
            </button>
          </span>
          {notes[row.id] && notes[row.id] !== "copied" ? (
            <code className="kim-backlog-followup-note">{notes[row.id]}</code>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The project page's follow-ups; hidden when there are none. */
export function FollowUpsSection({ projectId }: { projectId: string }) {
  const { followUps } = useFollowUps(projectId);
  const [decided, setDecided] = useState<Set<string>>(new Set());
  const open = (followUps ?? []).filter((item) => !decided.has(item.id));
  if (!open.length) return null;
  return (
    <div className="kim-backlog-followups">
      <div className="kim-backlog-head">
        <b>Follow-ups</b>
        <span className="kim-backlog-muted kim-backlog-small">
          left undone by finished sessions
        </span>
      </div>
      <FollowUpRows
        followUps={open}
        projectId={projectId}
        onDecided={(id) => setDecided((all) => new Set(all).add(id))}
      />
    </div>
  );
}

/** The inbox's follow_ups item: the same rows, done once none are left. */
export function FollowUpsDetail({
  item,
  done,
}: {
  item: InboxItem;
  done: () => void;
}) {
  const data = item.data as
    { projectId?: string; followUps?: FollowUpRow[] } | undefined;
  const [left, setLeft] = useState<FollowUpRow[]>(data?.followUps ?? []);
  const doneRef = useRef(done);
  doneRef.current = done;
  const finished = useRef(false);
  useEffect(() => {
    if (!left.length && !finished.current) {
      finished.current = true;
      doneRef.current();
    }
  }, [left]);
  return (
    <div className="kim-backlog-detail">
      <FollowUpRows
        followUps={left}
        projectId={data?.projectId ?? item.projectId}
        onDecided={(id) =>
          setLeft((rows) => rows.filter((row) => row.id !== id))
        }
      />
    </div>
  );
}
