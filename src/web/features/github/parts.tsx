import type { MouseEvent, ReactNode } from "react";
import {
  prLabel,
  type LogExcerpt,
  type PrCheck,
  type PrSummary,
} from "../../../shared/github.js";
import { checkTone, navigate } from "./api.js";

/** An in-app link: a plain click navigates without a reload. */
export function Link({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
      return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} className={className} onClick={click}>
      {children}
    </a>
  );
}

const LABEL_TONE: Record<ReturnType<typeof prLabel>, string> = {
  Ready: "green",
  "CI failed": "red",
  Pending: "pending",
  Draft: "grey",
  Open: "blue",
  Merged: "purple",
  Closed: "grey",
};

/** The tone a PR's icon and label take. */
export const prTone = (pr: Parameters<typeof prLabel>[0]) =>
  LABEL_TONE[prLabel(pr)];

export function PrIcon({ tone }: { tone: string }) {
  return (
    <svg
      className={`kim-github-icon kim-github-${tone}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M6 8v8" />
      <path d="M18 16V9a3 3 0 0 0-3-3h-4" />
    </svg>
  );
}

export function StateLabel({ pr }: { pr: PrSummary }) {
  return (
    <span className={`kim-github-state kim-github-${prTone(pr)}`}>
      {prLabel(pr)}
    </span>
  );
}

/** A dot per check, coloured by its outcome. */
export function CiDots({ checks }: { checks: PrCheck[] }) {
  if (!checks.length) return null;
  return (
    <span className="kim-github-dots" aria-label="Checks">
      {checks.map((check, index) => (
        <span
          key={`${check.name}-${index}`}
          className={`kim-github-dot kim-github-bg-${checkTone(check)}`}
          title={`${check.name}: ${check.conclusion ?? check.status}`}
        />
      ))}
    </span>
  );
}

/** +adds −dels */
export function Stats({ add, del }: { add: number; del: number }) {
  return (
    <span className="kim-github-stats">
      <span className="kim-github-add">+{add}</span>{" "}
      <span className="kim-github-del">−{del}</span>
    </span>
  );
}

/** A failing job's log: the lines around the first error, then the tail. */
export function LogBlock({ log }: { log: LogExcerpt }) {
  return (
    <pre className="kim-github-log">
      {log.around ? `${log.around.join("\n")}\n…\n` : ""}
      {log.tail.join("\n")}
    </pre>
  );
}

/** What to do when the Worker has no GITHUB_TOKEN. */
export function GitHubSetup() {
  return (
    <div className="kim-github-setup">
      <p>
        Pull requests need a GitHub token. Create a fine-grained token with read
        access to <b>contents</b>, <b>pull requests</b>, <b>checks</b>,{" "}
        <b>actions</b>, <b>issues</b> and <b>metadata</b> on your repos, then
        set it as a Worker secret:
      </p>
      <pre className="kim-github-log">npx wrangler secret put GITHUB_TOKEN</pre>
    </div>
  );
}
