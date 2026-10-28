import { ttlCache } from "./cache.js";
import type { Env } from "./env.js";
import { linkedEmails } from "./links.js";

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
  /** The linked account it was sent to, when not the signed-in one. */
  to?: string;
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
const ownerKey = (token: string) => `owner:${token}`;

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

/**
 * "Shared with you" lists read lately: a KV list call costs as much as a
 * write, and the home page asks on every load. Assigning updates this
 * isolate's copy; other isolates catch up within the TTL.
 */
const lists = ttlCache<SharedInterview[]>(30_000);

export const shareFor = (env: Env, token: string) =>
  shares.get(token, () => env.OAUTH_KV.get<Share>(shareKey(token), "json"));

export async function recordAssignment(
  env: Env,
  owner: string,
  change: Assignment,
): Promise<void> {
  for (const email of [change.previous, change.assignee])
    if (email) lists.delete(email);
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

/**
 * Whose workspace each interview is in, by token, so a page opened from
 * the wrong account can say so instead of looking deleted. Written when an
 * interview is made; older interviews get theirs the first time their
 * owner opens them.
 */
const owners = ttlCache<string | null>(30_000);

export const ownerOf = (env: Env, token: string) =>
  owners.get(token, () => env.OAUTH_KV.get(ownerKey(token)));

export async function recordOwner(env: Env, token: string, owner: string) {
  owners.set(token, owner.toLowerCase());
  await env.OAUTH_KV.put(ownerKey(token), owner.toLowerCase());
}

/** A deleted interview leaves nothing behind. */
export async function forgetShare(
  env: Env,
  token: string,
  assignee: string | null,
): Promise<void> {
  shares.set(token, null);
  owners.set(token, null);
  await env.OAUTH_KV.delete(shareKey(token));
  await env.OAUTH_KV.delete(ownerKey(token));
  if (!assignee) return;
  lists.delete(assignee);
  await env.OAUTH_KV.delete(assignedKey(assignee, token));
}

/** Interviews other people have assigned to this email, or one linked to it. */
export async function sharedWith(
  env: Env,
  email: string,
): Promise<SharedInterview[]> {
  const [self, ...linked] = await linkedEmails(env, email);
  const lists = await Promise.all(
    [self!, ...linked].map(async (to) =>
      (await assignedTo(env, to)).map((interview) => ({
        ...interview,
        ...(to === self ? {} : { to }),
      })),
    ),
  );
  return lists.flat();
}

/** Interviews assigned to exactly this address. */
const assignedTo = (env: Env, email: string): Promise<SharedInterview[]> =>
  lists.get(email.toLowerCase(), async () => {
    const prefix = assignedKey(email.toLowerCase(), "");
    const { keys } = await env.OAUTH_KV.list<
      Omit<SharedInterview, "token" | "to">
    >({ prefix });
    return keys.map((key) => ({
      token: key.name.slice(prefix.length),
      title: key.metadata?.title ?? "Interview",
      from: key.metadata?.from ?? "",
    }));
  });

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
