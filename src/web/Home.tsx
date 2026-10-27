import { useEffect, useState } from "react";
import { Account } from "./Account.js";
import { GetStarted } from "./GetStarted.js";
import { liveSocket, probeStatus, STOP_MESSAGES } from "./liveSocket.js";
import { NotifyToggle } from "./Notify.js";
import {
  homeOrder,
  ProjectChip,
  Progress,
  relativeTime,
  sessionState,
  useOverview,
  waitingOn,
} from "./overview.js";

/** An interview someone else assigned to the signed-in user to answer. */
interface SharedInterview {
  token: string;
  title: string;
  from: string;
}

/**
 * The site root: every interview and what's left to do on it, those
 * waiting on you first, plus the ones others have shared with you. The
 * badge says who each waits on, or that it's stopped.
 */
export function Home() {
  const [version, setVersion] = useState(0);
  const sessions = useOverview(version);
  const [shared, setShared] = useState<SharedInterview[]>([]);
  const [live, setLive] = useState("");

  useEffect(() => {
    // The server pings open pages whenever an interview changes.
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return liveSocket({
      url: `${protocol}//${location.host}/ws/overview`,
      probe: probeStatus("/api/browser/me"),
      onOpen: () => setLive(""),
      onMessage: () => setVersion((value) => value + 1),
      onStop: (reason) => setLive(STOP_MESSAGES[reason]),
    });
  }, []);

  useEffect(() => {
    void fetch("/api/browser/shared")
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ interviews: SharedInterview[] }>)
          : null,
      )
      .then((body) => setShared(body?.interviews ?? []))
      .catch(() => undefined);
  }, []);

  const count = (who: string) =>
    (sessions ?? []).filter((item) => waitingOn(item)?.who === who).length;
  const active = (sessions ?? []).filter(
    (item) => item.status === "active",
  ).length;

  return (
    <div className="home-page">
      <header className="top-bar">
        <a href="/" className="top-bar-brand">
          Keep it moving
        </a>
        <span className="spacer" />
        <NotifyToggle />
        <Account />
      </header>
      <main className="home">
        {live && (
          <div className="notice" role="status">
            {live}
          </div>
        )}
        <div className="home-head">
          <h1>Interviews</h1>
          {sessions && (
            <span className="home-summary">
              {count("you")} waiting on you · {active} active ·{" "}
              {sessions.length - active} stopped
            </span>
          )}
        </div>
        <GetStarted />
        {shared.length > 0 && (
          <section className="home-list" aria-label="Shared with you">
            <h2>Shared with you</h2>
            {shared.map((interview) => (
              <a
                key={interview.token}
                className="home-row"
                href={`/s/${interview.token}`}
              >
                <span className="home-row-main">
                  <span className="home-row-title">{interview.title}</span>
                  <span className="home-row-meta">
                    From {interview.from || "someone"}
                  </span>
                </span>
                <span className="state-badge state-you">For you to answer</span>
              </a>
            ))}
          </section>
        )}
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
        {sessions !== null && sessions.length > 0 && (
          <section className="home-list" aria-label="Your interviews">
            {shared.length > 0 && <h2>Yours</h2>}
            {homeOrder(sessions).map((item) => {
              const state = sessionState(item);
              return (
                <a
                  key={item.id}
                  className={`home-row ${item.status === "stopped" ? "stopped" : ""}`}
                  href={`/s/${item.token}`}
                >
                  <span className="home-row-main">
                    <span className="home-row-title">{item.title}</span>
                    <span className="home-row-meta">
                      {item.project && (
                        <span className="home-row-project">
                          <ProjectChip project={item.project} size={16} />
                          {item.project.name}
                        </span>
                      )}
                      {item.assignee && (
                        <span>Assigned to {item.assignee}</span>
                      )}
                      <span>{relativeTime(item.lastActivity)}</span>
                    </span>
                  </span>
                  <Progress answered={item.answered} total={item.total} long />
                  <span className={`state-badge ${state.className}`}>
                    {state.label}
                  </span>
                </a>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}
