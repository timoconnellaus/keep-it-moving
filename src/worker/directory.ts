import type { PublicKey } from "../shared/crypto.js";
import { ttlCache } from "./cache.js";
import type { Env } from "./env.js";
import { linkedEmails } from "./links.js";

/**
 * The public-key directory: each user's encryption public key, by email,
 * so an owner's client can wrap an interview key for an assignee (and for
 * the accounts linked to either). Public keys aren't secret; the hub keeps
 * the account's own, and this copy in KV is what other people look up.
 */
export interface ListedKey {
  fp: string;
  publicKey: PublicKey;
}

const keyOf = (email: string) => `pubkey:${email.toLowerCase()}`;

/** Lookups lately; setting up or resetting updates this isolate's copy. */
const listed = ttlCache<ListedKey | null>(30_000);

const lookup = (env: Env, email: string) =>
  listed.get(email.toLowerCase(), () =>
    env.OAUTH_KV.get<ListedKey>(keyOf(email), "json"),
  );

export async function listKey(env: Env, email: string, key: ListedKey) {
  listed.set(email.toLowerCase(), key);
  await env.OAUTH_KV.put(keyOf(email), JSON.stringify(key));
}

export async function unlistKey(env: Env, email: string) {
  listed.set(email.toLowerCase(), null);
  await env.OAUTH_KV.delete(keyOf(email));
}

/** The keys of an email and every account linked to it; emails stay out of it. */
export async function keysFor(env: Env, email: string): Promise<ListedKey[]> {
  const emails = await linkedEmails(env, email);
  const keys = await Promise.all(emails.map((each) => lookup(env, each)));
  return keys.filter((key): key is ListedKey => key !== null);
}

const PUBKEYS = /^\/api\/(sessions\/kim|browser)\/pubkeys$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `GET …/pubkeys[?email=]`: someone's keys, or the signed-in user's own. */
export async function pubkeys(
  request: Request,
  env: Env,
  email: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET" || !PUBKEYS.test(url.pathname)) return null;
  const asked = url.searchParams.get("email")?.trim().toLowerCase() || email;
  if (!EMAIL.test(asked))
    return Response.json({ error: "Not an email address" }, { status: 400 });
  return Response.json({ keys: await keysFor(env, asked) });
}

const ACCOUNT_KEY = /^\/api\/browser\/account\/(key|reset)$/;

/** Keeps the directory in step with a hub's reply to setting up or resetting. */
export async function trackAccountKey(
  request: Request,
  env: Env,
  email: string,
  response: Response,
): Promise<void> {
  const match = ACCOUNT_KEY.exec(new URL(request.url).pathname);
  if (!match || request.method !== "POST" || !response.ok) return;
  if (match[1] === "reset") return unlistKey(env, email);
  const { publicKey, fingerprint } = (await response.clone().json()) as {
    publicKey: PublicKey;
    fingerprint: string;
  };
  await listKey(env, email, { fp: fingerprint, publicKey });
}
