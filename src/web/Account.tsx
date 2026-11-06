import { useEffect, useRef, useState } from "react";
import { EncryptionMenu } from "./Encryption.js";
import { useMe, type PlanView } from "./me.js";

interface Links {
  linked: string[];
  max: number;
}

/**
 * Who is signed in, as an avatar in the top bar, with their plan, billing,
 * linked accounts and Sign out behind it.
 */
export function Account() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<Links | null>(null);
  const [linkError, setLinkError] = useState("");
  useEffect(() => {
    if (!open) return;
    void fetch("/api/browser/links")
      .then((response) =>
        response.ok ? (response.json() as Promise<Links>) : null,
      )
      .then(setLinks)
      .catch(() => undefined);
  }, [open]);
  const unlink = async (email: string) => {
    setLinkError("");
    const response = await fetch("/api/browser/links/unlink", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    if (response?.ok) setLinks((await response.json()) as Links);
    else setLinkError(`Couldn't unlink ${email}; try again.`);
  };
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!me?.email) return null;
  return (
    <div className="account" ref={root}>
      <button
        type="button"
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Signed in as ${me.email}`}
        title={me.email}
        onClick={() => setOpen((value) => !value)}
      >
        {me.picture ? (
          <img src={me.picture} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span aria-hidden="true">
            {(me.name ?? me.email).charAt(0).toUpperCase()}
          </span>
        )}
      </button>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-who">
            {me.name && <b>{me.name}</b>}
            <span>{me.email}</span>
          </div>
          {me.plan && <Plan plan={me.plan} />}
          <EncryptionMenu onAction={() => setOpen(false)} />
          {links && links.linked.length > 0 && (
            <div className="account-links" aria-label="Linked accounts">
              <span className="account-links-head">
                Linked: interviews sent to these open here too
              </span>
              {links.linked.map((email) => (
                <div key={email} className="account-link">
                  <span>{email}</span>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={`Unlink ${email}`}
                    onClick={() => void unlink(email)}
                  >
                    Unlink
                  </button>
                </div>
              ))}
              {linkError && <span role="alert">{linkError}</span>}
            </div>
          )}
          {/* Plain forms: the Worker sends the browser to Google, or ends the
              session and shows sign-in. */}
          {(!links || links.linked.length + 1 < links.max) && (
            <form method="post" action="/auth/google/link">
              <input
                type="hidden"
                name="next"
                value={location.pathname + location.search}
              />
              <button type="submit" role="menuitem">
                Link another Google account
              </button>
            </form>
          )}
          <form method="post" action="/auth/logout">
            <button type="submit" role="menuitem">
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

/** The plan, and Upgrade or Manage billing; both are forms the Worker sends to Stripe. */
function Plan({ plan }: { plan: PlanView }) {
  const until = plan.currentPeriodEnd
    ? new Date(plan.currentPeriodEnd).toLocaleDateString()
    : null;
  return (
    <div className="account-plan">
      <span>
        {plan.plan === "pro" ? "Pro" : "Free"} plan
        {plan.cancelAtPeriodEnd && until ? `, ends ${until}` : ""}
      </span>
      {plan.plan === "free" &&
        (plan.billing ? (
          <form method="post" action="/billing/checkout">
            <button type="submit" role="menuitem">
              Upgrade to Pro, $5/month
            </button>
          </form>
        ) : (
          <span className="account-soon">Pro is coming soon</span>
        ))}
      {plan.manageable && plan.source === "stripe" && (
        <form method="post" action="/billing/portal">
          <button type="submit" role="menuitem">
            Manage billing
          </button>
        </form>
      )}
      <a href="/pricing" role="menuitem">
        Compare plans
      </a>
    </div>
  );
}
