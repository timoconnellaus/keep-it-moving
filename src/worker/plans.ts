import type { Plan } from "../server/plans.js";
import { ttlCache } from "./cache.js";
import type { Env } from "./env.js";
import { isOwner } from "./hubs.js";
import { isAdmin } from "./users.js";

/**
 * Each user's plan, one KV key per email: what Stripe bills them for, and
 * any plan an admin granted by hand. Stripe's webhook and /admin write it;
 * everything else reads it through a short cache. With nothing stored, a
 * user is on Free.
 */
export interface PlanRecord {
  email: string;
  /** What the subscription is for. Team will add "team", with its seats. */
  plan: Plan;
  /** The subscription's Stripe status: active, past_due, canceled, … */
  status?: string;
  customerId?: string;
  subscriptionId?: string;
  /** When the paid period ends, as epoch ms. */
  currentPeriodEnd?: number;
  /** Cancelled in the portal: it stays Pro until currentPeriodEnd. */
  cancelAtPeriodEnd?: boolean;
  /** The subscription's quantity: 1 for Pro, one per member for Team. */
  seats?: number;
  /** A plan an admin granted, which holds whatever Stripe says. */
  comp?: { plan: Plan; by: string; at: number };
  /**
   * The newest Stripe event applied to this subscription, as its `created`
   * (seconds), so an older one that arrives late changes nothing.
   */
  stripeEventAt?: number;
  updatedAt: number;
}

/** Where a user's plan comes from, for the Account menu and /admin. */
export type PlanSource = "owner" | "admin" | "comp" | "stripe" | null;

/** A user's plan as the browser sees it. */
export interface PlanView {
  plan: Plan;
  source: PlanSource;
  /** Stripe checkout is set up on this deployment. */
  billing: boolean;
  /** They have a Stripe customer, so the portal has something to manage. */
  manageable: boolean;
  status?: string;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
}

const planKey = (email: string) => `plan:${email.trim().toLowerCase()}`;
const PLAN_PREFIX = "plan:";

/** Stripe statuses that still pay for Pro; past_due is Stripe retrying a card. */
const PAYING = new Set(["active", "trialing", "past_due"]);

export const billingConfigured = (env: Env) =>
  Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_PRO);

/**
 * Plans read in this isolate lately. A change made here updates it at once;
 * other isolates catch up within the TTL.
 */
export const plans = ttlCache<PlanRecord | null>(30_000);

export const planRecord = (env: Env, email: string) =>
  plans.get(email.trim().toLowerCase(), () =>
    env.OAUTH_KV.get<PlanRecord>(planKey(email), "json"),
  );

/** The plan and where it comes from: the owner and admins are always on Pro. */
export function resolvePlan(
  env: Env,
  email: string,
  record: PlanRecord | null,
): { plan: Plan; source: PlanSource } {
  if (isOwner(email, env)) return { plan: "pro", source: "owner" };
  if (isAdmin(env, email)) return { plan: "pro", source: "admin" };
  if (record?.comp) return { plan: record.comp.plan, source: "comp" };
  if (record && record.plan !== "free" && PAYING.has(record.status ?? ""))
    return { plan: record.plan, source: "stripe" };
  return { plan: "free", source: null };
}

/** The plan the hub enforces for this user's workspace. */
export const planOf = async (env: Env, email: string): Promise<Plan> =>
  resolvePlan(env, email, await planRecord(env, email)).plan;

export async function planView(env: Env, email: string): Promise<PlanView> {
  const record = await planRecord(env, email);
  const view: PlanView = {
    ...resolvePlan(env, email, record),
    billing: billingConfigured(env),
    manageable: Boolean(record?.customerId),
  };
  if (record?.status) view.status = record.status;
  if (record?.currentPeriodEnd) view.currentPeriodEnd = record.currentPeriodEnd;
  if (record?.cancelAtPeriodEnd) view.cancelAtPeriodEnd = true;
  return view;
}

/**
 * Changes a user's record, starting from what is stored (not the cache, so
 * two webhooks in a row each see the other's write in this isolate).
 * The whole record also goes in the key's metadata, so /admin lists every
 * plan in one call per 1,000 users.
 */
export async function updatePlan(
  env: Env,
  email: string,
  change: (record: PlanRecord) => PlanRecord,
): Promise<PlanRecord> {
  const address = email.trim().toLowerCase();
  const stored = await env.OAUTH_KV.get<PlanRecord>(planKey(address), "json");
  const record = {
    ...change(stored ?? { email: address, plan: "free", updatedAt: 0 }),
    updatedAt: Date.now(),
  };
  plans.set(address, record);
  await env.OAUTH_KV.put(planKey(address), JSON.stringify(record), {
    metadata: record,
  });
  return record;
}

/** An admin grants a plan by hand, or takes the grant back with null. */
export const setComp = (
  env: Env,
  email: string,
  plan: Plan | null,
  by: string,
) =>
  updatePlan(env, email, (record) => {
    const next = { ...record };
    if (plan) next.comp = { plan, by: by.toLowerCase(), at: Date.now() };
    else delete next.comp;
    return next;
  });

/** Every stored plan, by email, for /admin. */
export async function listPlans(env: Env): Promise<Map<string, PlanRecord>> {
  const found = new Map<string, PlanRecord>();
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list<PlanRecord>({
      prefix: PLAN_PREFIX,
      cursor: cursor ?? null,
    });
    for (const key of page.keys)
      if (key.metadata?.email) found.set(key.metadata.email, key.metadata);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return found;
}
