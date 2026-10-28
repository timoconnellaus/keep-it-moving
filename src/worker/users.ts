import type { User } from "./auth.js";
import type { Env } from "./env.js";

/**
 * Who has signed up, for the admin page: one KV key per user, with
 * everything in its metadata so the page is one list call per 1,000 users.
 * Written at sign-in and when a session is extended (at most daily), so
 * "last seen" is accurate to a day.
 */
export interface UserRecord {
  email: string;
  name?: string;
  /** First and latest sign-in or session extension, as epoch ms. */
  first?: number;
  last?: number;
}

const userKey = (email: string) => `user:${email.toLowerCase()}`;
const PROFILE_PREFIX = "profile:";

export async function recordUser(env: Env, user: User) {
  const key = userKey(user.email);
  const { metadata } = await env.OAUTH_KV.getWithMetadata<UserRecord>(
    key,
    "text",
  );
  const now = Date.now();
  const record: UserRecord = {
    email: user.email.toLowerCase(),
    first: metadata?.first ?? now,
    last: now,
  };
  const name = user.name ?? metadata?.name;
  if (name) record.name = name;
  await env.OAUTH_KV.put(key, "", { metadata: record });
}

/**
 * Everyone recorded, plus anyone who signed in before records began: they
 * left a profile (their name) at sign-in, but no dates. Most recent first.
 */
export async function listUsers(env: Env): Promise<UserRecord[]> {
  const users = new Map<string, UserRecord>();
  for await (const key of keys(env, "user:")) {
    const record = key.metadata as UserRecord | undefined;
    if (record?.email) users.set(record.email, record);
  }
  for await (const key of keys(env, PROFILE_PREFIX)) {
    const email = key.name.slice(PROFILE_PREFIX.length);
    if (!users.has(email)) users.set(email, { email });
  }
  return [...users.values()].sort(
    (a, b) => (b.last ?? 0) - (a.last ?? 0) || a.email.localeCompare(b.email),
  );
}

async function* keys(env: Env, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list<UserRecord>({
      prefix,
      cursor: cursor ?? null,
    });
    yield* page.keys;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

/** ADMIN_EMAILS is a comma-separated secret; without it there are no admins. */
export const isAdmin = (env: Env, email: string) =>
  (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((admin) => admin.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
