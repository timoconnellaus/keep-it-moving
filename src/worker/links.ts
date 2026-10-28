import { sameSite } from "../server/hub.js";
import type { User } from "./auth.js";
import { ttlCache } from "./cache.js";
import type { Env } from "./env.js";

/**
 * Linked accounts: Google accounts one person has proved they own, so an
 * interview sent to any of them opens for all of them. A group is
 * symmetric and transitive, and each email still has its own workspace:
 * links are consulted only for interviews sent to someone, never by
 * `hubFor` or the agent API.
 *
 * In KV, `link:<email>` names the email's group and `links:<group>` lists
 * its members. Access checks read only the `link:` keys, so two emails are
 * linked exactly when both point at the same group; a merge or unlink
 * that stops halfway leaves accounts unlinked, never linked by mistake.
 */
export const MAX_LINKED = 10;

const linkKey = (email: string) => `link:${email.toLowerCase()}`;
const membersKey = (group: string) => `links:${group}`;

/**
 * Groups looked up lately, most of them none. Linking and unlinking update
 * this isolate's copy; other isolates catch up within the TTL.
 */
const groups = ttlCache<string | null>(30_000);

const groupOf = (env: Env, email: string) =>
  groups.get(email.toLowerCase(), () => env.OAUTH_KV.get(linkKey(email)));

async function membersOf(env: Env, group: string): Promise<string[]> {
  return (await env.OAUTH_KV.get<string[]>(membersKey(group), "json")) ?? [];
}

/** Whether these two emails are the same person: equal, or linked. */
export async function samePerson(env: Env, a: string, b: string) {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const [groupA, groupB] = await Promise.all([
    groupOf(env, a),
    groupOf(env, b),
  ]);
  return groupA !== null && groupA === groupB;
}

/** Every email in this one's group, itself first. */
export async function linkedEmails(env: Env, email: string) {
  const self = email.toLowerCase();
  const group = await groupOf(env, self);
  if (!group) return [self];
  // A member whose own key no longer points here was unlinked.
  const members = await membersOf(env, group);
  const confirmed = await Promise.all(
    members.map(async (member) =>
      member !== self && (await groupOf(env, member)) === group ? member : null,
    ),
  );
  return [self, ...confirmed.filter((member) => member !== null)];
}

/** Why a link was refused, or null once it is made. */
export async function link(
  env: Env,
  a: string,
  b: string,
): Promise<"same" | "full" | null> {
  const [first, second] = [a.toLowerCase(), b.toLowerCase()];
  if (first === second) return "same";
  const [groupA, groupB] = await Promise.all([
    groupOf(env, first),
    groupOf(env, second),
  ]);
  if (groupA !== null && groupA === groupB) return null;
  const members = new Set([
    ...(groupA ? await linkedEmails(env, first) : [first]),
    ...(groupB ? await linkedEmails(env, second) : [second]),
  ]);
  if (members.size > MAX_LINKED) return "full";
  // Joining two groups moves the second's members into the first.
  const group = groupA ?? groupB ?? crypto.randomUUID();
  await env.OAUTH_KV.put(membersKey(group), JSON.stringify([...members]));
  for (const member of members)
    if ((await groupOf(env, member)) !== group) {
      groups.set(member, group);
      await env.OAUTH_KV.put(linkKey(member), group);
    }
  if (groupA && groupB) await env.OAUTH_KV.delete(membersKey(groupB));
  return null;
}

/** Takes `email` out of `by`'s group; false when it isn't in it. */
export async function unlink(env: Env, by: string, email: string) {
  const target = email.toLowerCase();
  const group = await groupOf(env, by);
  if (!group || !(await samePerson(env, by, target))) return false;
  const rest = (await linkedEmails(env, by)).filter(
    (member) => member !== target,
  );
  groups.set(target, null);
  await env.OAUTH_KV.delete(linkKey(target));
  if (rest.length > 1) {
    await env.OAUTH_KV.put(membersKey(group), JSON.stringify(rest));
    return true;
  }
  // One left is no group at all.
  for (const member of rest) {
    groups.set(member, null);
    await env.OAUTH_KV.delete(linkKey(member));
  }
  await env.OAUTH_KV.delete(membersKey(group));
  return true;
}

/** The Account menu's list: the other accounts linked to this one. */
export const linksResponse = async (env: Env, user: User) =>
  Response.json({
    linked: (await linkedEmails(env, user.email)).slice(1),
    max: MAX_LINKED,
  });

/** The Account menu's Unlink, from our own page; answers with the new list. */
export async function unlinkAccount(request: Request, env: Env, user: User) {
  if (!sameSite(request))
    return Response.json(
      { error: "Cross-site request refused" },
      { status: 403 },
    );
  const { email } = (await request.json().catch(() => ({}))) as {
    email?: unknown;
  };
  if (typeof email !== "string" || !(await unlink(env, user.email, email)))
    return Response.json(
      { error: "That account isn't linked to this one" },
      { status: 400 },
    );
  return linksResponse(env, user);
}
