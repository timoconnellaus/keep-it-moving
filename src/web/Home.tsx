import { useEffect, useState } from "react";
import {
  groupByProject,
  OriginLine,
  ProjectChip,
  Progress,
  sessionState,
  useOverview,
} from "./overview.js";
import { NotifyToggle } from "./Notify.js";

/** Every interview, grouped by project, at the site root. */
export function Home() {
  const [version, setVersion] = useState(0);
  const sessions = useOverview(version);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    // The server pings open pages whenever an interview changes.
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`${protocol}//${location.host}/ws/overview`);
      socket.onmessage = () => setVersion((value) => value + 1);
      socket.onclose = () => {
        if (!disposed) timer = setTimeout(connect, 2_000);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, []);

  const query = filter.trim().toLowerCase();
  const shown = (sessions ?? []).filter(
    (item) =>
      !query ||
      [item.title, item.project?.name, item.origin.branch].some((value) =>
        value?.toLowerCase().includes(query),
      ),
  );
  const count = (predicate: (state: string) => boolean) =>
    (sessions ?? []).filter((item) => predicate(sessionState(item).label))
      .length;

  return (
    <main className="home">
      <div className="home-head">
        <h1>Interviews</h1>
        {sessions && (
          <span className="home-summary">
            {count((state) => state === "Needs you")} need you ·{" "}
            {count((state) => state === "All answered")} all answered ·{" "}
            {count((state) => state === "Finished")} finished
          </span>
        )}
        <span className="spacer" />
        <NotifyToggle />
        <label className="home-filter">
          <span aria-hidden="true">⌕</span>
          <input
            type="text"
            aria-label="Filter interviews"
            placeholder="Filter by name or branch"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
      </div>
      {sessions === null && <p className="home-empty">Loading…</p>}
      {sessions !== null && !sessions.length && (
        <div className="empty">
          <h2>No interviews yet</h2>
          <p>
            Interviews appear here when an agent runs{" "}
            <code>kim session create</code>.
          </p>
        </div>
      )}
      {groupByProject(shown).map((group) => {
        const need = group.sessions.filter((item) => item.open > 0).length;
        return (
          <section
            key={group.project?.id ?? "none"}
            className="home-project"
            aria-label={group.project?.name ?? "No project"}
          >
            <div
              className="home-project-head"
              style={{
                background: group.project
                  ? `color-mix(in srgb, ${group.project.color} 9%, white)`
                  : undefined,
              }}
            >
              <ProjectChip project={group.project} size={26} />
              <span
                className="home-project-name"
                style={{ color: group.project?.color }}
              >
                {group.project?.name ?? "No project"}
              </span>
              <span className="home-project-count">
                {group.sessions.length} interview
                {group.sessions.length === 1 ? "" : "s"}
                {need ? ` · ${need} need${need === 1 ? "s" : ""} you` : ""}
              </span>
              <span className="spacer" />
              {group.project && (
                <span className="home-project-key">{group.project.key}</span>
              )}
            </div>
            {group.sessions.map((item) => {
              const state = sessionState(item);
              return (
                <div
                  key={item.id}
                  className={`home-row ${item.status === "stopped" ? "finished" : ""}`}
                >
                  <div className="home-row-main">
                    <a className="home-row-title" href={`/s/${item.token}`}>
                      {item.title}
                    </a>
                    <OriginLine session={item} />
                  </div>
                  <Progress answered={item.answered} total={item.total} />
                  <span className={`state-badge ${state.className}`}>
                    {state.label}
                  </span>
                  <a
                    className={item.open > 0 ? "home-answer" : "home-open"}
                    href={`/s/${item.token}`}
                  >
                    {item.open > 0 ? `Answer ${item.open}` : "Open"}
                  </a>
                </div>
              );
            })}
          </section>
        );
      })}
    </main>
  );
}
