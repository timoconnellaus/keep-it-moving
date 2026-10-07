import type { PrDetailResponse } from "../../../shared/github.js";
import type { InboxItem } from "../../../shared/inbox.js";
import { checkTone, prHref, useKim } from "./api.js";
import { GitHubSetup, Link, LogBlock, Stats } from "./parts.js";

/** A failed CI item: the failing checks, their log tails and a link to the PR. */
export function CiFailedDetail({
  item,
}: {
  item: InboxItem;
  done: () => void;
}) {
  const data = item.data as {
    projectId: string;
    number: number;
    url: string;
    failing: string[];
  };
  const [detail] = useKim<PrDetailResponse>(
    `/projects/${encodeURIComponent(data.projectId)}/prs/${data.number}`,
  );
  const checks =
    detail.status === "ok"
      ? detail.data.checks.filter((check) => checkTone(check) === "red")
      : [];
  return (
    <div className="kim-github-inbox">
      <div className="kim-github-chips">
        {detail.status === "ok"
          ? detail.data.checks.map((check, index) => (
              <span
                key={`${check.name}-${index}`}
                className={`kim-github-chip kim-github-chip-${checkTone(check)}`}
              >
                {checkTone(check) === "red"
                  ? "✕"
                  : checkTone(check) === "green"
                    ? "✓"
                    : "•"}{" "}
                {check.name}
              </span>
            ))
          : data.failing.map((name) => (
              <span key={name} className="kim-github-chip kim-github-chip-red">
                ✕ {name}
              </span>
            ))}
      </div>
      {detail.status === "loading" && (
        <p className="kim-github-muted">Fetching the log…</p>
      )}
      {detail.status === "setup" && <GitHubSetup />}
      {detail.status === "error" && (
        <p className="kim-github-error">{detail.error}</p>
      )}
      {checks.map((check, index) =>
        check.log ? (
          <div key={`${check.name}-${index}`}>
            <div className="kim-github-muted">{check.name}</div>
            <LogBlock log={check.log} />
          </div>
        ) : null,
      )}
      {detail.status === "ok" && !checks.some((check) => check.log) && (
        <p className="kim-github-muted">
          No log excerpt: the failing checks don't run on GitHub Actions.
        </p>
      )}
      <div className="kim-github-actions">
        <Link
          href={prHref(data.projectId, data.number)}
          className="kim-github-button"
        >
          Open PR {data.number}
        </Link>
        <a
          href={data.url}
          target="_blank"
          rel="noreferrer"
          className="kim-github-button"
        >
          GitHub ↗
        </a>
      </div>
    </div>
  );
}

interface ReadyPr {
  number: number;
  title: string;
  url: string;
  additions: number;
  deletions: number;
  headRef: string;
}

/** Ready-to-merge PRs with their diff stats, each linking to its PR page. */
export function PrsReadyDetail({
  item,
}: {
  item: InboxItem;
  done: () => void;
}) {
  const data = item.data as { numbers: number[]; prs?: ReadyPr[] };
  const prs: ReadyPr[] =
    data.prs ??
    data.numbers.map((number) => ({
      number,
      title: "",
      url: "",
      additions: 0,
      deletions: 0,
      headRef: "",
    }));
  return (
    <ul className="kim-github-inbox kim-github-rows">
      {prs.map((pr) => (
        <li key={pr.number} className="kim-github-check-row">
          <span className="kim-github-green">✓</span>
          <span className="kim-github-main">
            <span className="kim-github-title">
              #{pr.number} {pr.title}
            </span>
            <span className="kim-github-meta">
              <Stats add={pr.additions} del={pr.deletions} />
              {pr.headRef && (
                <>
                  {" "}
                  · <span className="kim-github-mono">{pr.headRef}</span>
                </>
              )}
            </span>
          </span>
          {item.projectId && (
            <Link href={prHref(item.projectId, pr.number)}>Diff</Link>
          )}
        </li>
      ))}
    </ul>
  );
}
