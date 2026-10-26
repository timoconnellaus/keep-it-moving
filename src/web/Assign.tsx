import { useEffect, useRef, useState } from "react";
import type { SessionView } from "../shared/schema.js";

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
    const response = await fetch(`/api/browser/${token}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: next }),
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
        {session.assignee ? `Assigned to ${session.assignee}` : "Assign"}
      </button>
      {open && (
        <div className="assign-menu" role="dialog" aria-label="Assign">
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
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button type="submit" disabled={!email.trim()}>
              {session.assignee ? "Reassign" : "Assign"}
            </button>
          </form>
          {session.assignee && (
            <>
              <p>
                Send them this link. They sign in with Google as{" "}
                {session.assignee}, and see only this interview.
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
