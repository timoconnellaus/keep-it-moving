import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary, SessionView } from "../shared/schema.js";
import {
  groupByProject,
  OriginLine,
  ProjectChip,
  Progress,
  sessionState,
} from "./overview.js";

const touchScreen = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

const matches = (session: SessionSummary, query: string) =>
  !query ||
  [
    session.title,
    session.project?.name,
    session.origin.branch,
    session.origin.worktree,
    session.origin.agentSession,
  ].some((value) => value?.toLowerCase().includes(query));

/**
 * The interview title as a menu of every interview, grouped by project.
 * A dot on the button says another interview is waiting on the user.
 */
export function Switcher({
  session,
  sessions,
}: {
  session: SessionView;
  sessions: SessionSummary[] | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const root = useRef<HTMLDivElement | null>(null);
  const waiting = (sessions ?? []).filter(
    (item) => item.id !== session.id && item.open > 0,
  ).length;

  const groups = useMemo(
    () =>
      groupByProject(
        (sessions ?? []).filter((item) =>
          matches(item, query.trim().toLowerCase()),
        ),
      ),
    [sessions, query],
  );
  const flat = groups.flatMap((group) => group.sessions);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const go = (target: SessionSummary | undefined, newTab: boolean) => {
    if (!target) return;
    const url = `/s/${target.token}`;
    if (newTab) window.open(url, "_blank", "noopener");
    else if (target.id !== session.id) window.location.assign(url);
    setOpen(false);
  };

  return (
    <div className="switcher" ref={root}>
      <button
        type="button"
        className="switcher-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="Switch interview (⌘K)"
      >
        <ProjectChip project={session.project} size={24} />
        <span className="switcher-titles">
          {session.project && (
            <span className="switcher-project">{session.project.name}</span>
          )}
          <h1>{session.title}</h1>
        </span>
        <span className="switcher-caret" aria-hidden="true">
          ▾
        </span>
        {waiting > 0 && (
          <span
            className="waiting-dot"
            aria-label={`${waiting} other interview${waiting === 1 ? "" : "s"} waiting on you`}
          >
            {waiting}
          </span>
        )}
      </button>
      {open && (
        <div
          className="switcher-menu"
          role="dialog"
          aria-label="Switch interview"
        >
          <label className="switcher-search">
            <span aria-hidden="true">⌕</span>
            <input
              // On a phone, focusing would open the keyboard over the list.
              autoFocus={!touchScreen()}
              type="text"
              aria-label="Search interviews"
              placeholder="Jump to an interview, project or branch…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlight((value) => Math.min(value + 1, flat.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlight((value) => Math.max(value - 1, 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  go(flat[highlight], event.metaKey || event.ctrlKey);
                }
              }}
            />
            <kbd>⌘K</kbd>
          </label>
          <button
            type="button"
            className="switcher-close"
            onClick={() => setOpen(false)}
          >
            Close
          </button>
          <div className="switcher-list">
            {sessions === null && <p className="switcher-empty">Loading…</p>}
            {sessions !== null && !flat.length && (
              <p className="switcher-empty">No interviews match.</p>
            )}
            {groups.map((group) => (
              <div key={group.project?.id ?? "none"} className="switcher-group">
                <div className="switcher-group-head">
                  <ProjectChip project={group.project} />
                  <span>{group.project?.name ?? "No project"}</span>
                </div>
                {group.sessions.map((item) => {
                  const index = flat.indexOf(item);
                  const state = sessionState(item);
                  return (
                    <a
                      key={item.id}
                      href={`/s/${item.token}`}
                      className={`switcher-row ${index === highlight ? "highlighted" : ""} ${item.status === "stopped" ? "finished" : ""}`}
                      aria-current={item.id === session.id ? "page" : undefined}
                      onMouseEnter={() => setHighlight(index)}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey) return;
                        event.preventDefault();
                        go(item, false);
                      }}
                    >
                      <span className="switcher-row-main">
                        <span className="switcher-row-title">
                          {item.title}
                          {item.id === session.id && (
                            <span className="this-tab"> · this tab</span>
                          )}
                        </span>
                        <OriginLine session={item} />
                      </span>
                      <Progress answered={item.answered} total={item.total} />
                      <span className={`state-badge ${state.className}`}>
                        {item.open > 0 ? `${item.open} open` : state.label}
                      </span>
                    </a>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="switcher-foot">
            <span>↑↓ move</span>
            <span>↵ open</span>
            <span>⌘↵ new tab</span>
            <span className="spacer" />
            <a href="/">All interviews →</a>
          </div>
        </div>
      )}
    </div>
  );
}
