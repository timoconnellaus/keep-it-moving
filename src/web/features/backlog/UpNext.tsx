import { useState } from "react";
import type {
  BacklogItemView,
  BacklogStatus,
} from "../../../shared/backlog.js";
import {
  ago,
  copyText,
  syncBacklog,
  useProjectBacklog,
  type SyncResult,
} from "./api.js";

const STATUS: Record<BacklogStatus, { label: string; className: string }> = {
  in_progress: { label: "In progress", className: "kim-backlog-active" },
  todo: { label: "Todo", className: "kim-backlog-muted" },
  done: { label: "Done", className: "kim-backlog-done" },
  cancelled: { label: "Cancelled", className: "kim-backlog-muted" },
};

/** "#7" for an issue number; a source's own id (ENG-42) as it is. */
function itemId(item: BacklogItemView) {
  if (item.origin === "local") return "·";
  return /^\d+$/.test(item.sourceId) ? `#${item.sourceId}` : item.sourceId;
}

/** The backlog in milestone order, with Sync now. */
export function UpNextSection({ projectId }: { projectId: string }) {
  const { view, error } = useProjectBacklog(projectId);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [copied, setCopied] = useState(false);
  const sync = async () => {
    setSyncing(true);
    setCopied(false);
    setResult(await syncBacklog(projectId));
    setSyncing(false);
  };
  const settings = view?.settings;
  const syncLabel = syncing
    ? "syncing…"
    : settings?.syncedAt
      ? `synced ${ago(settings.syncedAt)}`
      : "never synced";
  return (
    <div className="kim-backlog-upnext">
      <div className="kim-backlog-head">
        <b>Up next</b>
        <span className="kim-backlog-muted kim-backlog-small">
          backlog, in milestone order
        </span>
        <button
          type="button"
          className="kim-backlog-sync"
          onClick={() => void sync()}
          disabled={syncing || !view}
          aria-label="Sync now"
          title="Sync now"
        >
          {syncLabel} <span aria-hidden="true">↻</span>
        </button>
      </div>
      {result && !result.ok ? (
        <div className="kim-backlog-note" role="status">
          {result.error}
          {result.command ? (
            <div className="kim-backlog-command">
              <code>{result.command}</code>
              <button
                type="button"
                onClick={() =>
                  void copyText(result.command!).then((ok) => setCopied(ok))
                }
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : null}
        </div>
      ) : settings?.syncError ? (
        <div className="kim-backlog-note kim-backlog-error" role="status">
          Last sync failed: {settings.syncError}
        </div>
      ) : null}
      {!view ? (
        <p className="kim-backlog-muted">{error ?? "Loading…"}</p>
      ) : view.upNext.length ? (
        <ul className="kim-backlog-list">
          {view.upNext.map((item) => (
            <li key={item.sourceId} className="kim-backlog-row">
              <span className="kim-backlog-id">{itemId(item)}</span>
              <span className="kim-backlog-title">
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.title}
                  </a>
                ) : (
                  item.title
                )}
              </span>
              <span
                className={`kim-backlog-small ${STATUS[item.status].className}`}
              >
                {STATUS[item.status].label}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="kim-backlog-muted">
          {view.settings.source === "none"
            ? "No backlog source yet. Set one with `interviewer backlog source github|script`."
            : "Nothing open in the backlog."}
        </p>
      )}
    </div>
  );
}
