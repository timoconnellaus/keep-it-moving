import { useState } from "react";
import type { PrListResponse } from "../../../shared/github.js";
import { ago, kimFetch, prHref, useKim } from "./api.js";
import {
  CiDots,
  GitHubSetup,
  Link,
  PrIcon,
  StateLabel,
  Stats,
  prTone,
} from "./parts.js";

/** The project page's "Pull requests" section: open PRs with state and CI. */
export function PullRequests({ projectId }: { projectId: string }) {
  const path = `/projects/${encodeURIComponent(projectId)}/prs`;
  const [list, setList] = useKim<PrListResponse>(path);
  const [syncing, setSyncing] = useState(false);
  const sync = async () => {
    setSyncing(true);
    const result = await kimFetch<PrListResponse>(`${path}/sync`, {
      method: "POST",
    });
    setSyncing(false);
    // A failed sync keeps the list on screen, with the error above it.
    if (result.status !== "error") setList(result);
    else if (list.status === "ok")
      setList({ ...list, data: { ...list.data, error: result.error } });
    else setList(result);
  };
  const ready =
    list.status === "ok" ? list.data.prs.filter((pr) => pr.ready).length : 0;
  return (
    <section className="kim-github-section">
      <header className="kim-github-head">
        <b>Pull requests</b>
        {ready > 0 && (
          <span className="kim-github-muted">{ready} ready to merge</span>
        )}
        {list.status === "ok" && list.data.repo && (
          <button
            type="button"
            className="kim-github-sync"
            onClick={() => void sync()}
            disabled={syncing}
            title={`Synced ${ago(list.data.syncedAt)}`}
          >
            {syncing ? "Syncing…" : "Sync"}
          </button>
        )}
      </header>
      {list.status === "loading" && (
        <p className="kim-github-muted">Loading…</p>
      )}
      {list.status === "setup" && <GitHubSetup />}
      {list.status === "error" && (
        <p className="kim-github-error">{list.error}</p>
      )}
      {list.status === "ok" && (
        <>
          {list.data.error && (
            <p className="kim-github-error">
              Last sync failed: {list.data.error}
            </p>
          )}
          {!list.data.repo ? (
            <p className="kim-github-muted">
              This project isn't a GitHub repo.
            </p>
          ) : !list.data.prs.length ? (
            <p className="kim-github-muted">
              {list.data.syncedAt
                ? "No open pull requests."
                : "Not synced yet. Sync to load its pull requests."}
            </p>
          ) : (
            <ul className="kim-github-rows">
              {list.data.prs.map((pr) => (
                <li key={pr.number}>
                  <Link
                    href={prHref(projectId, pr.number)}
                    className="kim-github-row"
                  >
                    <PrIcon tone={prTone(pr)} />
                    <span className="kim-github-main">
                      <span className="kim-github-title">
                        #{pr.number} {pr.title}
                      </span>
                      <span className="kim-github-meta">
                        <Stats add={pr.additions} del={pr.deletions} /> ·{" "}
                        <span className="kim-github-mono">{pr.headRef}</span> ·{" "}
                        {pr.author}
                      </span>
                    </span>
                    <span className="kim-github-end">
                      <StateLabel pr={pr} />
                      <CiDots checks={pr.checks} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
