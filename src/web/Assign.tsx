import { useEffect, useRef, useState } from "react";
import type { SessionView } from "../shared/schema.js";
import { encryption } from "./keys.js";
import { onFree, useMe } from "./me.js";

/**
 * Hands the interview to someone else to answer: they sign in with Google as
 * that email at this page's link, which the owner sends them. Their answers
 * come back here and to the agent.
 */
export function Assign({
  token,
  session,
  onChanged,
}: {
  token: string;
  session: SessionView;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(session.assignee ?? "");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  // Free can't assign; an assignment made earlier keeps working.
  const locked = onFree(useMe());
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    setEmail(session.assignee ?? "");
    setError("");
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open, session.assignee]);

  const save = async (next: string | null) => {
    setError("");
    // An encrypted interview's key goes to the assignee's keys, wrapped here.
    let grants: Array<{ fp: string; wrapped: string }> | undefined;
    try {
      grants = next
        ? await encryption.assigneeGrants(session.kid, next)
        : undefined;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    const response = await fetch(`/api/browser/${token}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: next, ...(grants ? { grants } : {}) }),
    });
    if (!response.ok) {
      setError(
        ((await response.json().catch(() => ({}))) as { error?: string })
          .error ?? `HTTP ${response.status}`,
      );
      return;
    }
    onChanged();
  };
  const copy = async () => {
    await navigator.clipboard?.writeText(session.url).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="assign" ref={root}>
      <button
        type="button"
        className={`assign-button ${session.assignee ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="Have someone else answer this interview"
      >
        {/* On phones the icon stands in for the words, which screen readers still get. */}
        <svg
          className="assign-icon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="6.5" cy="5.5" r="2.6" />
          <path d="M1.8 13.5c.6-2.4 2.4-3.8 4.7-3.8s4.1 1.4 4.7 3.8M12.5 5v4M10.5 7h4" />
        </svg>
        <span className="assign-text">
          {session.assignee ? `Assigned to ${session.assignee}` : "Assign"}
        </span>
        {locked && !session.assignee && <span className="pro-badge">Pro</span>}
      </button>
      {open && (
        <div className="assign-menu" role="dialog" aria-label="Assign">
          {locked && (
            <p className="assign-pro">
              Assigning interviews to other people is a Pro feature.{" "}
              <a href="/pricing">Upgrade to Pro</a>
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save(email.trim() || null);
            }}
          >
            <label>
              Who answers it
              <input
                type="email"
                value={email}
                placeholder="name@example.com"
                disabled={locked}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button type="submit" disabled={locked || !email.trim()}>
              {session.assignee ? "Reassign" : "Assign"}
            </button>
          </form>
          {session.assignee && (
            <>
              <p>
                Send them this link. They sign in with Google as{" "}
                {session.assignee}, and see only this interview.
                {session.kid &&
                  !session.assigneeKey &&
                  " It's end-to-end encrypted: once they've turned on encryption, this page offers to give them access."}
              </p>
              <div className="assign-actions">
                <button type="button" onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy link"}
                </button>
                <button type="button" onClick={() => void save(null)}>
                  Stop sharing
                </button>
              </div>
            </>
          )}
          {error && <p className="assign-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
