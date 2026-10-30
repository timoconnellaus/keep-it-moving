import { DRAFTER_HEADER, RESPONDENT_HEADER } from "../server/hub.js";
import type { Env } from "./env.js";
import { hubFor } from "./hubs.js";
import { samePerson } from "./links.js";
import { shareFor, sharedWith } from "./shares.js";

/**
 * The inbox: interviews other people sent to this user, as their own
 * agent works on them (`kim inbox`, `kim draft`). Each lives in its
 * sender's hub, which the agent reaches the way the assignee's browser
 * does, as the assignee, and only for that one interview: sent to this
 * user or an account linked to theirs. Agent keys can't use it; what was
 * sent to someone is theirs, not a cloud environment's.
 */
const INBOX = /^\/api\/sessions\/inbox(?:\/([^/]+)(\/.*)?)?$/;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

export const isInbox = (path: string) => INBOX.test(path);

/** An agent's request to its inbox (see isInbox). */
export async function inbox(
  request: Request,
  env: Env,
  email: string,
  via: string | undefined,
): Promise<Response> {
  const match = INBOX.exec(new URL(request.url).pathname);
  if (!match) return notAllowed();
  if (via === "key")
    return Response.json(
      {
        error:
          "Agent keys can't open interviews sent to you; use a signed-in CLI",
      },
      { status: 403 },
    );
  const [, first, rest = ""] = match;
  if (!first)
    return request.method === "GET"
      ? Response.json({ interviews: await unfinished(env, email, request) })
      : notAllowed();
  // Waiting on everything sent to this user is a socket in their own hub.
  if (first === "socket" && !rest)
    return hubFor(env, email).fetch(
      new Request(new URL("/internal/inbox/socket", request.url), request),
    );
  if (first === "take" && !rest && request.method === "POST")
    return Response.json({
      interviews: (
        await Promise.all(
          (await reachable(env, email)).map(async (share) =>
            (
              await toOwner(
                env,
                email,
                share,
                "/take",
                new Request(request.url, { method: "POST" }),
              )
            ).json(),
          ),
        )
      ).filter((news) => (news as { news?: boolean }).news),
    });
  if (!TOKEN.test(first)) return notSentToYou();
  const share = await shareFor(env, first);
  if (!share || !(await samePerson(env, email, share.assignee)))
    return notSentToYou();
  return toOwner(env, email, { token: first, ...share }, rest, request);
}

interface Reachable {
  token: string;
  owner: string;
  assignee: string;
}

/** Interviews sent to this user or a linked account that the directory still confirms. */
async function reachable(env: Env, email: string): Promise<Reachable[]> {
  const listed = await sharedWith(env, email);
  const shares = await Promise.all(
    listed.map(async ({ token }) => {
      const share = await shareFor(env, token);
      return share && (await samePerson(env, email, share.assignee))
        ? { token, ...share }
        : null;
    }),
  );
  return shares.filter((share) => share !== null);
}

/** `kim inbox`: what is still waiting on this user, with how much is drafted. */
async function unfinished(env: Env, email: string, request: Request) {
  const summaries = await Promise.all(
    (await reachable(env, email)).map(async (share) => {
      const response = await toOwner(
        env,
        email,
        share,
        "/summary",
        new Request(request.url),
      );
      return response.ok
        ? ((await response.json()) as { status: string; openQuestions: number })
        : null;
    }),
  );
  return summaries.filter(
    (summary) =>
      summary && summary.status === "active" && summary.openQuestions > 0,
  );
}

/** The request, in the sender's hub, as the assignee and naming whose agent asks. */
function toOwner(
  env: Env,
  email: string,
  share: Reachable,
  rest: string,
  request: Request,
) {
  const forwarded = new Request(
    new URL(`/api/inbox/${share.token}${rest}`, request.url),
    request,
  );
  // Only the Worker may say who is asking.
  forwarded.headers.set(RESPONDENT_HEADER, share.assignee);
  forwarded.headers.set(DRAFTER_HEADER, email.toLowerCase());
  return hubFor(env, share.owner).fetch(forwarded);
}

const notSentToYou = () =>
  Response.json(
    { error: "That interview wasn't sent to you" },
    { status: 403 },
  );
const notAllowed = () =>
  Response.json({ error: "Not allowed" }, { status: 405 });
