import { useState, type CSSProperties } from "react";
import type { InboxItem, InboxKind } from "../../../shared/inbox.js";
import { inboxDetails } from "../registry.js";
import { Icon, type IconName } from "./icons.js";
import { age } from "./live.js";
import type { RailProject } from "./ProjectRail.js";

const KINDS: Record<InboxKind, { label: string; icon: IconName }> = {
  request: { label: "Request", icon: "alert" },
  needs_you: { label: "Needs you", icon: "alert" },
  ci_failed: { label: "CI failed", icon: "ciRed" },
  automation_down: { label: "Automation down", icon: "heartbeat" },
  follow_ups: { label: "Follow-ups", icon: "followUp" },
  prs_ready: { label: "PRs ready", icon: "pr" },
};

/** An idle agent finished its turn; it waits, but nothing is blocked. */
const kindOf = (item: InboxItem) =>
  item.kind === "needs_you" && item.data?.status === "idle"
    ? { label: "Waiting", icon: "pause" as const }
    : KINDS[item.kind];

/**
 * The inbox: everything that needs Tim, oldest first, with the selected
 * item on the right. At phone width the list fills the screen and choosing
 * an item shows only its detail.
 */
export function Inbox({
  items,
  projects,
  done,
  snooze,
}: {
  /** Visible items (not done or snoozed here), or null while loading. */
  items: InboxItem[] | null;
  projects: RailProject[] | null;
  done: (id: string) => void;
  snooze: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const list = items ?? [];
  const current = list.find((item) => item.id === selectedId) ?? list[0];
  const projectOf = (item: InboxItem) =>
    projects?.find((project) => project.id === item.projectId);

  /** Hides the current item here and moves to the one after it. */
  const advance = (hide: (id: string) => void) => {
    if (!current) return;
    const index = list.indexOf(current);
    const next = list[index + 1] ?? list[index - 1];
    hide(current.id);
    setSelectedId(next?.id ?? null);
    if (!next) setShowDetail(false);
  };

  const Detail = current ? inboxDetails[current.kind] : undefined;
  const project = current && projectOf(current);
  const kind = current && kindOf(current);

  return (
    <div className={`kim-shell-inbox ${showDetail ? "showing-detail" : ""}`}>
      <section className="kim-shell-inbox-list" aria-label="Inbox">
        <div className="kim-shell-inbox-head">
          <b>Needs you</b>
          {items && <span className="kim-shell-quiet">{list.length} left</span>}
          <span className="kim-shell-inbox-order">Oldest first</span>
        </div>
        {items === null && <p className="kim-shell-empty">Loading…</p>}
        {items !== null && !list.length && (
          <p className="kim-shell-empty">Inbox zero. Everything is moving.</p>
        )}
        {list.map((item) => {
          const itemProject = projectOf(item);
          const itemKind = kindOf(item);
          return (
            <button
              type="button"
              key={item.id}
              className={`kim-shell-inbox-row kim-shell-kind-${item.kind} ${item.later ? "idle" : ""} ${item === current ? "selected" : ""}`}
              aria-current={item === current ? "true" : undefined}
              onClick={() => {
                setSelectedId(item.id);
                setShowDetail(true);
              }}
            >
              <Icon name={itemKind.icon} className="kim-shell-kind-icon" />
              <span className="kim-shell-inbox-row-main">
                <span className="kim-shell-inbox-meta">
                  <span
                    className="kim-shell-swatch"
                    style={
                      {
                        "--project": itemProject?.color,
                      } as CSSProperties
                    }
                    aria-hidden="true"
                  />
                  {itemProject?.name ?? "No project"} · {itemKind.label}
                  <span className="kim-shell-age">{age(item.since)}</span>
                </span>
                <span className="kim-shell-inbox-title">{item.title}</span>
              </span>
            </button>
          );
        })}
      </section>
      <section className="kim-shell-detail" aria-label="Selected item">
        {current && kind ? (
          <>
            <button
              type="button"
              className="kim-shell-back"
              onClick={() => setShowDetail(false)}
            >
              <Icon name="back" /> Inbox
            </button>
            <div className="kim-shell-detail-head">
              <span
                className="kim-shell-swatch"
                style={{ "--project": project?.color } as CSSProperties}
                aria-hidden="true"
              />
              <span>{project?.name ?? "No project"}</span>
              <span>·</span>
              <span
                className={`kim-shell-kind kim-shell-kind-${current.kind} ${current.later ? "idle" : ""}`}
              >
                {kind.label}
              </span>
              {current.source && (
                <>
                  <span>·</span>
                  <span>{current.source}</span>
                </>
              )}
              <span className="kim-shell-detail-actions">
                <button
                  type="button"
                  className="kim-shell-button"
                  onClick={() => advance(snooze)}
                  title="Hide it here for an hour"
                >
                  Snooze
                </button>
                <button
                  type="button"
                  className="kim-shell-button primary"
                  onClick={() => advance(done)}
                >
                  Done → next
                </button>
              </span>
            </div>
            <h1 className="kim-shell-detail-title">{current.title}</h1>
            {current.brief && (
              <div className="kim-shell-brief">
                <div className="kim-shell-brief-label">Brief</div>
                <div className="kim-shell-brief-text">{current.brief}</div>
              </div>
            )}
            {Detail && (
              <div className="kim-shell-detail-body">
                <Detail
                  key={current.id}
                  item={current}
                  done={() => advance(done)}
                />
              </div>
            )}
          </>
        ) : (
          <div className="kim-shell-empty">
            <h1 className="kim-shell-detail-title">Nothing needs you</h1>
            <p>Every project is moving.</p>
          </div>
        )}
      </section>
    </div>
  );
}
