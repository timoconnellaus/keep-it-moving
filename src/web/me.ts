import { useEffect, useState } from "react";

/** The signed-in user's plan, as the Worker reports it with /api/browser/me. */
export interface PlanView {
  plan: "free" | "pro";
  source: "owner" | "admin" | "comp" | "stripe" | null;
  /** Stripe checkout is set up; without it Pro is coming soon. */
  billing: boolean;
  /** There is Stripe billing to manage in the portal. */
  manageable: boolean;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
}

export interface Me {
  email: string;
  name?: string;
  picture?: string;
  plan?: PlanView;
}

/** Who is signed in, and on which plan; null until it loads, or signed out. */
export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/browser/me")
      .then((response) =>
        response.ok ? (response.json() as Promise<Me>) : null,
      )
      .then((value) => {
        if (live) setMe(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return me;
}

/** Free, as far as the page knows: an older Worker reports no plan. */
export const onFree = (me: Me | null) => me?.plan?.plan === "free";
