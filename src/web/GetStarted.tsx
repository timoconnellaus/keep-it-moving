import { useState } from "react";

const DISMISSED_KEY = "kim.getStarted.dismissed";

/** Storage can be missing or throw (private windows, blocked site data). */
function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * How to run interviews from Claude Code: install the CLI from this site,
 * add the skill (it asks which agents), sign in. Dismissing it hides it
 * for good on this browser.
 */
export function GetStarted() {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [copied, setCopied] = useState(false);
  if (dismissed) return null;

  const commands = [
    `npm install -g ${location.origin}/cli.tgz`,
    "kim skill install",
    "kim login",
  ].join("\n");
  const copy = async () => {
    await navigator.clipboard?.writeText(commands).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Hidden for this visit only.
    }
    setDismissed(true);
  };

  return (
    <section className="get-started" aria-label="Use it with Claude Code">
      <div className="get-started-head">
        <h2>Use it with Claude Code</h2>
        <button
          type="button"
          className="get-started-dismiss"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={dismiss}
        >
          ×
        </button>
      </div>
      <div className="get-started-commands">
        <pre>{commands}</pre>
        <button type="button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p>
        <code>kim skill install</code> asks which agents get the skill. Then ask
        Claude to interview you about something — e.g. “interview me about this
        feature”.
      </p>
    </section>
  );
}
