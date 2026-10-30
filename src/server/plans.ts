/**
 * What each plan allows, as the hub enforces it. The Worker looks up the
 * workspace owner's plan and sets it in PLAN_HEADER on every request it
 * sends a hub, stripping whatever a client sent, like the respondent header.
 * A request without it came from inside (a test, the Worker's own calls) and
 * has no limits.
 */
export const PLAN_HEADER = "x-kim-plan";

/** Team ($5 a seat, shared workspaces) comes next, as "team". */
export type Plan = "free" | "pro";

/** Free: at most this many interviews with an agent waiting at once. */
export const FREE_LIVE_LIMIT = 3;

/** The `code` on a 402 refusal, which the CLI and the page recognise. */
export const PLAN_LIMIT = "plan_limit";

export const pricingUrl = (baseUrl: string) => `${baseUrl}/pricing`;

/** One interview an agent is waiting on, named in a refusal. */
export interface LiveInterview {
  id: string;
  title: string;
  url: string;
}

/** The body of a 402: what was refused, why, and where to upgrade. */
export interface PlanRefusal {
  error: string;
  code: typeof PLAN_LIMIT;
  plan: Plan;
  feature: "live" | "assign";
  upgradeUrl: string;
  /** For `live`: the interviews holding the Free plan's places. */
  live?: LiveInterview[];
  limit?: number;
}

export function liveRefusal(
  baseUrl: string,
  live: LiveInterview[],
): PlanRefusal {
  const upgradeUrl = pricingUrl(baseUrl);
  const names = live
    .map((interview) => `"${interview.title}" (${interview.id})`)
    .join(", ");
  return {
    error: `The Free plan has an agent waiting on at most ${FREE_LIVE_LIMIT} interviews at once, and ${live.length} already are: ${names}. Stop one with \`kim session stop <id>\`, or upgrade to Pro for no limit: ${upgradeUrl}`,
    code: PLAN_LIMIT,
    plan: "free",
    feature: "live",
    limit: FREE_LIVE_LIMIT,
    live,
    upgradeUrl,
  };
}

export function assignRefusal(baseUrl: string): PlanRefusal {
  const upgradeUrl = pricingUrl(baseUrl);
  return {
    error: `Assigning interviews to other people is a Pro feature. Upgrade to Pro: ${upgradeUrl}`,
    code: PLAN_LIMIT,
    plan: "free",
    feature: "assign",
    upgradeUrl,
  };
}

/** The routes an agent waits on an interview through. */
export const WATCH_ROUTE =
  /^\/api\/sessions\/([^/]+)\/(socket|wait|attach|events\/next)$/;

/** The route an agent's hook takes answers from, without waiting (POST). */
export const TAKE_ROUTE = /^\/api\/sessions\/([^/]+)\/take$/;

/** The routes that assign an interview, by id or by browser token. */
export const ASSIGN_ROUTE = /^\/api\/(?:sessions|browser)\/[^/]+\/assign$/;
