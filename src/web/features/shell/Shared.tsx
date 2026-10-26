import { useJson } from "./live.js";

interface SharedInterview {
  token: string;
  title: string;
  from: string;
}

/** Interviews other people have assigned to the signed-in user to answer. */
export function SharedWithYou() {
  const interviews = useJson<{ interviews: SharedInterview[] }>(
    "/api/browser/shared",
  ).data?.interviews;
  if (!interviews?.length) return null;
  return (
    <section className="kim-shared" aria-label="Shared with you">
      <div className="kim-shell-inbox-head">
        <b>Shared with you</b>
      </div>
      {interviews.map((interview) => (
        <a
          key={interview.token}
          className="kim-shell-inbox-row"
          href={`/s/${interview.token}`}
        >
          <span className="kim-shell-inbox-row-main">
            <span className="kim-shell-inbox-meta">From {interview.from}</span>
            <span className="kim-shell-inbox-title">{interview.title}</span>
          </span>
        </a>
      ))}
    </section>
  );
}
