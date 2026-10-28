import { sameSite } from "../server/hub.js";
import type { User } from "./auth.js";
import type { Env } from "./env.js";
import { escapeHtml, page } from "./pages.js";
import {
  billingConfigured,
  planRecord,
  resolvePlan,
  updatePlan,
  type PlanRecord,
} from "./plans.js";

/**
 * Stripe, over its REST API with fetch and Web Crypto: Checkout to start
 * Pro, the Customer Portal to manage or cancel it, and a webhook that keeps
 * each user's plan record in step. Without the secrets, upgrading says Pro
 * is coming soon and nothing calls Stripe.
 */
export const STRIPE_API = "https://api.stripe.com/v1";

/**
 * Marks our checkouts and subscriptions. The Stripe account may sell other
 * things, and its webhook sends their events here too: anything without
 * this tag, or that isn't the subscription we recorded, is left alone.
 */
export const STRIPE_APP = "keep-it-moving";

/** Which user a Stripe customer is, for subscription events. */
const customerKey = (customer: string) => `stripe-customer:${customer}`;
/** Events already applied: Stripe delivers at least once. */
const eventKey = (id: string) => `stripe-event:${id}`;
const EVENT_TTL = 30 * 24 * 60 * 60;
/** Stripe's own default: a signature older than this is a replay. */
const TOLERANCE_S = 5 * 60;

const comingSoon = () =>
  page(
    200,
    'Pro is coming soon. Until then, Free has everything but assigning, for up to three live interviews at once. <a href="/pricing">See the plans</a>.',
  );

async function stripe<T>(
  env: Env,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: params ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(params
        ? { "content-type": "application/x-www-form-urlencoded" }
        : {}),
    },
    ...(params ? { body: new URLSearchParams(params).toString() } : {}),
  });
  const value = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string };
  };
  if (!response.ok)
    throw new Error(
      value.error?.message ?? `Stripe answered ${response.status}`,
    );
  return value;
}

/** The Account menu's Upgrade: a Checkout session for Pro, then off to Stripe. */
export async function checkout(request: Request, env: Env, user: User) {
  if (!sameSite(request))
    return new Response("Cross-site request refused", { status: 403 });
  if (!billingConfigured(env)) return comingSoon();
  const record = await planRecord(env, user.email);
  const { plan, source } = resolvePlan(env, user.email, record);
  if (source === "stripe") return portal(request, env, user);
  if (plan === "pro")
    return page(
      200,
      'You\'re on Pro already. <a href="/">Back to your interviews</a>.',
    );
  const origin = new URL(env.PUBLIC_URL).origin;
  const email = user.email.toLowerCase();
  const params: Record<string, string> = {
    mode: "subscription",
    "line_items[0][price]": env.STRIPE_PRICE_PRO!,
    "line_items[0][quantity]": "1",
    success_url: `${origin}/pricing?checkout=done`,
    cancel_url: `${origin}/pricing`,
    client_reference_id: email,
    "metadata[email]": email,
    "metadata[app]": STRIPE_APP,
    // On the subscription too, so its events say whose it is.
    "subscription_data[metadata][email]": email,
    "subscription_data[metadata][app]": STRIPE_APP,
  };
  if (record?.customerId) params.customer = record.customerId;
  else params.customer_email = email;
  try {
    const session = await stripe<{ url?: string }>(
      env,
      "/checkout/sessions",
      params,
    );
    if (!session.url) throw new Error("no checkout URL");
    return Response.redirect(session.url, 303);
  } catch (error) {
    return page(
      502,
      `Stripe didn't start the checkout (${escape(error)}). <a href="/pricing">Try again</a>.`,
    );
  }
}

/** Manage billing: the Customer Portal, for cards, invoices and cancelling. */
export async function portal(request: Request, env: Env, user: User) {
  if (!sameSite(request))
    return new Response("Cross-site request refused", { status: 403 });
  if (!env.STRIPE_SECRET_KEY) return comingSoon();
  const record = await planRecord(env, user.email);
  if (!record?.customerId)
    return page(
      200,
      'There\'s no Stripe billing on this account to manage. <a href="/pricing">See the plans</a>.',
    );
  try {
    const session = await stripe<{ url?: string }>(
      env,
      "/billing_portal/sessions",
      {
        customer: record.customerId,
        return_url: `${new URL(env.PUBLIC_URL).origin}/`,
        // Our own portal settings, so it never offers the account's other products.
        ...(env.STRIPE_PORTAL_CONFIGURATION
          ? { configuration: env.STRIPE_PORTAL_CONFIGURATION }
          : {}),
      },
    );
    if (!session.url) throw new Error("no portal URL");
    return Response.redirect(session.url, 303);
  } catch (error) {
    return page(
      502,
      `Stripe didn't open billing (${escape(error)}). <a href="/">Back</a>.`,
    );
  }
}

const escape = (error: unknown) =>
  escapeHtml(error instanceof Error ? error.message : String(error));

interface StripeEvent {
  id: string;
  type: string;
  /** Seconds since the epoch. */
  created: number;
  data: { object: Record<string, unknown> };
}

interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  /** Before API version 2025-03-31 the period was on the subscription. */
  current_period_end?: number;
  items?: {
    data?: Array<{ quantity?: number; current_period_end?: number }>;
  };
}

/**
 * POST /stripe/webhook: public, but only Stripe can sign it. Each event is
 * applied once; a repeat is acknowledged and changes nothing.
 */
export async function stripeWebhook(request: Request, env: Env) {
  if (!env.STRIPE_WEBHOOK_SECRET)
    return Response.json({ error: "Billing isn't set up" }, { status: 503 });
  const payload = await request.text();
  if (
    !(await verifySignature(
      payload,
      request.headers.get("stripe-signature"),
      env.STRIPE_WEBHOOK_SECRET,
    ))
  )
    return Response.json({ error: "Bad signature" }, { status: 400 });
  const event = JSON.parse(payload) as StripeEvent;
  if (await env.OAUTH_KV.get(eventKey(event.id)))
    return Response.json({ received: true, duplicate: true });
  // Another product's event: acknowledged, and nothing stored.
  if (!(await applyEvent(env, event)))
    return Response.json({ received: true, ignored: true });
  await env.OAUTH_KV.put(eventKey(event.id), String(event.created), {
    expirationTtl: EVENT_TTL,
  });
  return Response.json({ received: true });
}

/** Applies one of our events; false for anything that isn't ours. */
async function applyEvent(env: Env, event: StripeEvent): Promise<boolean> {
  const object = event.data.object;
  if (event.type === "checkout.session.completed") {
    const metadata = object.metadata as Record<string, string> | undefined;
    if (object.mode !== "subscription" || metadata?.app !== STRIPE_APP)
      return false;
    const email = stringField(object.client_reference_id, metadata.email);
    const customer = stringField(object.customer);
    const id = stringField(object.subscription);
    if (!email || !customer || !id) return false;
    await env.OAUTH_KV.put(customerKey(customer), email.toLowerCase());
    // The session says it was paid, but not until when: ask Stripe.
    const subscription = await stripe<StripeSubscription>(
      env,
      `/subscriptions/${encodeURIComponent(id)}`,
    ).catch(() => null);
    const paid =
      object.payment_status === "paid" ||
      object.payment_status === "no_payment_required";
    await applySubscription(
      env,
      email,
      event,
      subscription ?? {
        id,
        customer,
        status: paid ? "active" : "incomplete",
      },
    );
    return true;
  }
  if (
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const subscription = object as unknown as StripeSubscription;
    const tagged = subscription.metadata?.app === STRIPE_APP;
    const email =
      (tagged ? subscription.metadata?.email : undefined) ??
      (await env.OAUTH_KV.get(customerKey(subscription.customer)));
    if (!email) return false;
    // Untagged, it's ours only if it's the subscription we recorded: one of
    // our customers may also subscribe to the account's other products.
    if (
      !tagged &&
      (await planRecord(env, email))?.subscriptionId !== subscription.id
    )
      return false;
    await applySubscription(env, email, event, subscription);
    return true;
  }
  return false;
}

async function applySubscription(
  env: Env,
  email: string,
  event: StripeEvent,
  subscription: StripeSubscription,
) {
  const deleted = event.type === "customer.subscription.deleted";
  await updatePlan(env, email, (record) => {
    const current = record.subscriptionId === subscription.id;
    // An older subscription ending doesn't touch the newer one.
    if (deleted && record.subscriptionId && !current) return record;
    if (current && (record.stripeEventAt ?? 0) > event.created) return record;
    const item = subscription.items?.data?.[0];
    const periodEnd =
      item?.current_period_end ?? subscription.current_period_end;
    const next: PlanRecord = {
      ...record,
      plan: "pro",
      status: deleted ? "canceled" : subscription.status,
      customerId: subscription.customer,
      subscriptionId: subscription.id,
      stripeEventAt: event.created,
    };
    if (periodEnd) next.currentPeriodEnd = periodEnd * 1000;
    if (item?.quantity) next.seats = item.quantity;
    if (subscription.cancel_at_period_end && !deleted)
      next.cancelAtPeriodEnd = true;
    else delete next.cancelAtPeriodEnd;
    return next;
  });
}

const stringField = (...values: unknown[]) =>
  values.find(
    (value): value is string => typeof value === "string" && value !== "",
  );

/**
 * Stripe-Signature is `t=<seconds>,v1=<hex>[,v1=…]`: an HMAC-SHA256 of
 * `<t>.<raw body>` keyed with the endpoint's whole signing secret. Several
 * v1 values appear while a rolled secret is still valid; any may match.
 */
export async function verifySignature(
  payload: string,
  header: string | null,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!header) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    const [name, value] = [part.slice(0, at).trim(), part.slice(at + 1)];
    if (name === "t") timestamp = value;
    if (name === "v1") signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp) || !signatures.length) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_S) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = [
    ...new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(`${timestamp}.${payload}`),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return signatures.some((signature) => sameText(signature, expected));
}

/** Compares in time that doesn't depend on where they differ. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
