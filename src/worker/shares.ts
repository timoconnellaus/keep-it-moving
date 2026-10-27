import { ttlCache } from "./cache.js";
import type { Env } from "./env.js";

/**
 * The share directory: which owner's workspace holds an interview assigned
 * to someone else, so the Worker can route the assignee there, and what each
 * person has been assigned. The interview itself stays in the owner's hub,
 * which checks the assignee again on every request.
 */
export interface Share {
  owner: string;
  assignee: string;
}

/** One interview in someone's "Shared with you" list. */
export interface SharedInterview {
  token: string;
  title: string;
  from: string;
}

/** The hub's reply to an assign: what changed, for the directory. */
export interface Assignment {
  token: string;
  title: string;
  assignee: string | null;
  previous: string | null;
  assignedBy: string | null;
}

const shareKey = (token: string) => `share:${token}`;
const assignedKey = (email: string, token: string) =>
  `assigned:${email}:${token}`;
const profileKey = (email: string) => `profile:${email.toLowerCase()}`;

/** A browser token in an interview's page, socket or API path. */
const TOKEN_PATH = /^\/(?:s|ws|api\/browser)\/([A-Za-z0-9_-]{32})(?:\/|$)/;

export const interviewToken = (path: string) =>
  TOKEN_PATH.exec(path)?.[1] ?? null;

/**
 * Shares looked up lately, most of them none: the owner's own interviews.
 * Assigning updates this isolate's copy; other isolates catch up within
 * the TTL, and the owner's hub checks the assignee on every request anyway.
 */
const shares = ttlCache<Share | null>(30_000);

export const shareFor = (env: Env, token: string) =>
  shares.get(token, () => env.OAUTH_KV.get<Share>(shareKey(token), "json"));

export async function recordAssignment(
  env: Env,
  owner: string,
  change: Assignment,
): Promise<void> {
  if (change.previous && change.previous !== change.assignee)
    await env.OAUTH_KV.delete(assignedKey(change.previous, change.token));
  if (!change.assignee) {
    shares.set(change.token, null);
    await env.OAUTH_KV.delete(shareKey(change.token));
    return;
  }
  const share = { owner: owner.toLowerCase(), assignee: change.assignee };
  shares.set(change.token, share);
  await env.OAUTH_KV.put(shareKey(change.token), JSON.stringify(share));
  const listed: Omit<SharedInterview, "token"> = {
    title: change.title,
    from: change.assignedBy ?? owner,
  };
  await env.OAUTH_KV.put(assignedKey(change.assignee, change.token), "", {
    metadata: listed,
  });
}

/** A deleted interview leaves nothing behind. */
export async function forgetShare(
  env: Env,
  token: string,
  assignee: string | null,
): Promise<void> {
  shares.set(token, null);
  await env.OAUTH_KV.delete(shareKey(token));
  if (assignee) await env.OAUTH_KV.delete(assignedKey(assignee, token));
}

/** Interviews other people have assigned to this email. */
export async function sharedWith(
  env: Env,
  email: string,
): Promise<SharedInterview[]> {
  const prefix = assignedKey(email.toLowerCase(), "");
  const { keys } = await env.OAUTH_KV.list<Omit<SharedInterview, "token">>({
    prefix,
  });
  return keys.map((key) => ({
    token: key.name.slice(prefix.length),
    title: key.metadata?.title ?? "Interview",
    from: key.metadata?.from ?? "",
  }));
}

/** The name Google gave at sign-in, for the CLI, which only knows the email. */
export const saveProfile = (env: Env, email: string, name: string) =>
  env.OAUTH_KV.put(profileKey(email), name);

export const profileName = (env: Env, email: string) =>
  env.OAUTH_KV.get(profileKey(email));

/** j•••@example.com: enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  return `${name.charAt(0)}•••@${domain}`;
}
