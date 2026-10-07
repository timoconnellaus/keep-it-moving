import { safeHref } from "../../../shared/url.js";
import type { PrDetailResponse } from "../../../shared/github.js";
import { checkTone, useKim } from "./api.js";
import { DiffViewer } from "./Diff.js";
import {
  GitHubSetup,
  Link,
  LogBlock,
  PrIcon,
  StateLabel,
  Stats,
  prTone,
} from "./parts.js";

/** /p/<projectId>/pr/<number>: checks with failing logs, reviews, then the diff. */
export function PrPage({
  projectId,
  match,
}: {
  projectId: string;
  match: RegExpMatchArray;
}) {
  const number = Number(match[1]);
  const [detail] = useKim<PrDetailResponse>(
    `/projects/${encodeURIComponent(projectId)}/prs/${number}`,
  );
  const back = (
    <Link
      href={`/p/${encodeURIComponent(projectId)}`}
      className="kim-github-back"
    >
      ← Project
    </Link>
  );
  if (detail.status !== "ok")
    return (
      <div className="kim-github-page">
        {back}
        {detail.status === "loading" && (
          <p className="kim-github-muted">Loading PR #{number}…</p>
        )}
        {detail.status === "setup" && <GitHubSetup />}
        {detail.status === "error" && (
          <p className="kim-github-error">{detail.error}</p>
        )}
      </div>
    );
  const { pr, checks, reviews, files, filesTruncated } = detail.data;
  return (
    <div className="kim-github-page">
      {back}
      <header className="kim-github-pr-head">
        <h1>
          <PrIcon tone={prTone(pr)} />
          <span>
            {pr.title} <span className="kim-github-muted">#{pr.number}</span>
          </span>
        </h1>
        <div className="kim-github-meta">
          <StateLabel pr={pr} /> ·{" "}
          <span className="kim-github-mono">
            {pr.headRef} → {pr.baseRef}
          </span>{" "}
          · {pr.author} · <Stats add={pr.additions} del={pr.deletions} /> ·{" "}
          <a href={safeHref(pr.url)} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </header>

      <section className="kim-github-section">
        <header className="kim-github-head">
          <b>Checks</b>
          {pr.mergeableState && (
            <span className="kim-github-muted">
              mergeable state: {pr.mergeableState}
            </span>
          )}
        </header>
        {!checks.length && <p className="kim-github-muted">No checks ran.</p>}
        <ul className="kim-github-rows">
          {checks.map((check, index) => (
            <li key={`${check.name}-${index}`} className="kim-github-check">
              <div className="kim-github-check-row">
                <span
                  className={`kim-github-dot kim-github-bg-${checkTone(check)}`}
                />
                <span className="kim-github-main">{check.name}</span>
                <span className="kim-github-muted">
                  {check.conclusion ?? check.status.replace("_", " ")}
                </span>
                {check.url && (
                  <a
                    href={safeHref(check.url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Details
                  </a>
                )}
              </div>
              {check.log && <LogBlock log={check.log} />}
            </li>
          ))}
        </ul>
      </section>

      <section className="kim-github-section">
        <header className="kim-github-head">
          <b>Reviews</b>
        </header>
        {!reviews.length ? (
          <p className="kim-github-muted">No reviews yet.</p>
        ) : (
          <ul className="kim-github-rows">
            {reviews.map((review) => (
              <li key={review.author} className="kim-github-check-row">
                <span className="kim-github-main">{review.author}</span>
                <span
                  className={
                    review.state === "APPROVED"
                      ? "kim-github-green"
                      : review.state === "CHANGES_REQUESTED"
                        ? "kim-github-red"
                        : "kim-github-muted"
                  }
                >
                  {review.state.toLowerCase().replace("_", " ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="kim-github-section">
        <header className="kim-github-head">
          <b>Files changed</b>
          <span className="kim-github-muted">
            {files.length}
            {filesTruncated ? "+" : ""} files
          </span>
        </header>
        {filesTruncated && (
          <p className="kim-github-muted">
            Showing the first {files.length} files;{" "}
            <a href={`${pr.url}/files`} target="_blank" rel="noreferrer">
              the rest are on GitHub
            </a>
            .
          </p>
        )}
        <DiffViewer files={files} />
      </section>
    </div>
  );
}
