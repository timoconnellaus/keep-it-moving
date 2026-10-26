import { useEffect, useRef, useState } from "react";
import { useJson } from "./live.js";

interface Me {
  email: string;
  name?: string;
  picture?: string;
}

/** Who is signed in, as an avatar in the top bar, with Sign out behind it. */
export function Account() {
  const me = useJson<Me>("/api/browser/me").data;
  const [open, setOpen] = useState(false);
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
    <div className="kim-account" ref={root}>
      <button
        type="button"
        className="kim-account-button"
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
        <div className="kim-account-menu" role="menu">
          <div className="kim-account-who">
            {me.name && <b>{me.name}</b>}
            <span>{me.email}</span>
          </div>
          {/* A plain form: the Worker ends the session and shows sign-in. */}
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
