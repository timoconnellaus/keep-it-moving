import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import {
  currentUser,
  googleCallback,
  googleStart,
  isLoopback,
  linkStart,
  logout,
  safeNext,
  signInUrl,
  type User,
} from "./auth.js";
import { KEY_PREFIX, sha256, VIA_KEY_HEADER } from "../server/keys.js";
import {
  ASSIGNED_BY_HEADER,
  DRAFTER_HEADER,
  RESPONDENT_HEADER,
  sameSite,
} from "../server/hub.js";
import { PLAN_HEADER } from "../server/plans.js";
import type { Env } from "./env.js";
import { ttlCache } from "./cache.js";
import { hubFor } from "./hubs.js";
import { inbox, isInbox } from "./inbox.js";
import { isAdmin, listUsers } from "./users.js";
import {
  adminPage,
  escapeHtml,
  page,
  pricingPage,
  signInPage,
} from "./pages.js";
import {
  listPlans,
  planOf,
  planRecord,
  planView,
  resolvePlan,
  setComp,
} from "./plans.js";
import { checkout, portal, stripeWebhook } from "./stripe.js";
import { DESIGN_VIEWER_PATH } from "../server/designPage.js";
import {
  linkedEmails,
  linksResponse,
  samePerson,
  unlinkAccount,
} from "./links.js";
import {
  forgetShare,
  interviewToken,
  maskEmail,
  ownerOf,
  profileName,
  recordAssignment,
  recordOwner,
  shareFor,
  sharedWith,
  type Assignment,
  type Share,
} from "./shares.js";

export { InterviewHub } from "./hub.js";

const PUBLIC_FILES =
  /^\/(assets\/|icons\/|manifest\.webmanifest$|sw\.js$|cli\.tgz$|cli-version\.json$)/;

/** Where an agent key downloads the CLI package. */
const CLI_PACKAGE_PATH = "/api/sessions/kim/cli.tgz";

/** Which user an agent key belongs to, by the key's hash. */
const keyOwner = (hash: string) => `agent-key:${hash}`;

/**
 * Key owners read lately. A key's owner never changes, so only its hub's
 * verdict, asked on every request, decides whether it still works.
 */
const keyOwners = ttlCache<string | null>(5 * 60_000);

const AGENT_ASSIGN = /^\/api\/sessions\/[^/]+\/assign$/;
const AGENT_DELETE = /^\/api\/sessions\/(?!kim(?:\/|$))[^/]+$/;
const BROWSER_ASSIGN = /^\/api\/browser\/[^/]+\/assign$/;

/** Headers only the Worker may set; whatever a client sent is dropped. */
function forwardable(request: Request): Request {
  const forwarded = new Request(request);
  for (const header of [
    VIA_KEY_HEADER,
    RESPONDENT_HEADER,
    ASSIGNED_BY_HEADER,
    DRAFTER_HEADER,
    PLAN_HEADER,
  ])
    forwarded.headers.delete(header);
  return forwarded;
}

/** Sends a request to this user's hub, telling it their plan. */
async function toHub(env: Env, email: string, forwarded: Request) {
  forwarded.headers.set(PLAN_HEADER, await planOf(env, email));
  return hubFor(env, email).fetch(forwarded);
}

/** An owner can't assign an interview to themselves. */
async function assignsToSelf(request: Request, email: string) {
  const input = (await request
    .clone()
    .json()
    .catch(() => ({}))) as { email?: unknown };
  return (
    typeof input.email === "string" &&
    input.email.trim().toLowerCase() === email.toLowerCase()
  );
}

/**
 * Sends an assign to the owner's hub, naming who assigns it, and keeps the
 * share directory in step with the reply.
 */
async function assign(
  env: Env,
  owner: string,
  name: string,
  forwarded: Request,
): Promise<Response> {
  if (await assignsToSelf(forwarded, owner))
    return Response.json(
      { error: "That's your own email; assign it to someone else" },
      { status: 400 },
    );
  forwarded.headers.set(ASSIGNED_BY_HEADER, encodeURIComponent(name));
  const response = await toHub(env, owner, forwarded);
  if (response.ok)
    await recordAssignment(
      env,
      owner,
      (await response.clone().json()) as Assignment,
    );
  return response;
}

/** The agent API: OAuth access tokens issued to the CLI, each routed to its user's workspace. */
const agentApi: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const props = (
      ctx as ExecutionContext & { props?: { email?: string; via?: string } }
    ).props;
    const email = props?.email;
    if (!email) return Response.json({ error: "Not allowed" }, { status: 403 });
    const limited = await userLimited(env, email, request);
    if (limited) return limited;
    // The CLI package, for a cloud setup script holding the environment's
    // agent key: behind the token, so nothing new is public.
    const path = new URL(request.url).pathname;
    if (path === CLI_PACKAGE_PATH)
      return env.ASSETS.fetch(new Request(new URL("/cli.tgz", request.url)));
    // Interviews sent to this user live in their senders' hubs.
    if (isInbox(path))
      return inbox(forwardable(request), env, email, props.via);
    // Tell the hub which requests a key made; a client can't claim either way.
    const forwarded = forwardable(request);
    if (props.via === "key") forwarded.headers.set(VIA_KEY_HEADER, "1");
    if (request.method === "POST" && AGENT_ASSIGN.test(path))
      return assign(
        env,
        email,
        (await profileName(env, email)) ?? email,
        forwarded,
      );
    const response = await toHub(env, email, forwarded);
    if (request.method === "DELETE" && AGENT_DELETE.test(path) && response.ok) {
      const { token, assignee } = (await response.clone().json()) as {
        token?: string;
        assignee?: string | null;
      };
      if (token) await forgetShare(env, token, assignee ?? null);
    }
    // Remember whose it is, for a link opened from another account.
    if (request.method === "POST" && path === "/api/sessions" && response.ok) {
      const { token } = (await response.clone().json()) as { token?: string };
      if (token) await recordOwner(env, token, email);
    }
    // A new key remembers whose it is, so it reaches the same workspace.
    if (
      request.method === "POST" &&
      path === "/api/sessions/kim/keys" &&
      response.ok
    ) {
      const { key } = (await response.clone().json()) as { key?: string };
      if (key) {
        const hash = await sha256(key);
        keyOwners.set(hash, email);
        await env.OAUTH_KV.put(keyOwner(hash), email);
      }
    }
    return response;
  },
};

/** A design viewer file, open to sandboxed frames. */
async function designViewerFile(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(response.body, { status: response.status, headers });
}

/** Everything else: Google sign-in, the OAuth authorize step, the browser UI, and its API. */
const site: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // Build output and app-install files hold nothing private, and Google's
    // servers fetch the icons without a sign-in when installing. A cloud
    // environment's setup script installs the CLI from cli.tgz, and `kim`
    // checks cli-version.json for a newer one.
    if (PUBLIC_FILES.test(url.pathname)) return env.ASSETS.fetch(request);
    // A design's frame is sandboxed with an opaque origin, so the viewer's
    // modules (loaded with CORS) need to be readable from anywhere.
    if (url.pathname.startsWith(DESIGN_VIEWER_PATH))
      return designViewerFile(request, env);
    if (url.pathname === "/auth/google/start") return googleStart(request, env);
    if (url.pathname === "/auth/google/callback")
      return googleCallback(request, env);
    if (url.pathname === "/auth/logout" && request.method === "POST")
      return logout(request, env);
    // Only Stripe can sign it, so it needs no sign-in.
    if (url.pathname === "/stripe/webhook" && request.method === "POST")
      return stripeWebhook(request, env);
    const user = await currentUser(request, env);
    // Public, and says what to do next to whoever is signed in.
    if (url.pathname === "/pricing")
      return pricingPage(
        user ? await planView(env, user.email) : null,
        url.searchParams.get("checkout") === "done"
          ? "Thanks! Pro turns on as soon as Stripe confirms the payment, usually within a few seconds."
          : null,
      );
    if (url.pathname === "/signin")
      return user
        ? Response.redirect(
            new URL(safeNext(url.searchParams.get("next")), url).toString(),
            302,
          )
        : signInPage(safeNext(url.searchParams.get("next")), env.PUBLIC_URL);
    if (!user) {
      // Signed out, the front door is the marketing page (landing.html, built from docs/marketing).
      if (url.pathname === "/")
        return env.ASSETS.fetch(new Request(new URL("/landing", url)));
      // The CLI's login was started on purpose, so go straight to Google.
      if (url.pathname === "/authorize")
        return Response.redirect(
          new URL(signInUrl(url, true), url).toString(),
          302,
        );
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/"))
        return Response.json({ error: "Sign in first" }, { status: 401 });
      return Response.redirect(new URL(signInUrl(url), url).toString(), 302);
    }
    if (url.pathname === "/authorize") return authorize(request, env, user);
    if (url.pathname === "/api/browser/me")
      return Response.json({ ...user, plan: await planView(env, user.email) });
    if (request.method === "POST" && url.pathname === "/billing/checkout")
      return checkout(request, env, user);
    if (request.method === "POST" && url.pathname === "/billing/portal")
      return portal(request, env, user);
    if (url.pathname === "/auth/google/link" && request.method === "POST")
      return linkStart(request, env, user);
    if (url.pathname === "/api/browser/links") return linksResponse(env, user);
    if (
      url.pathname === "/api/browser/links/unlink" &&
      request.method === "POST"
    )
      return unlinkAccount(request, env, user);
    // Not found, not forbidden: no hint that it exists.
    if (url.pathname === "/admin" || url.pathname === "/admin/plan")
      return isAdmin(env, user.email)
        ? admin(request, env, user)
        : new Response("Not found", { status: 404 });
    // Everything past here reaches a Durable Object or KV for this user.
    const limited = await userLimited(env, user.email, request);
    if (limited) return limited;
    if (url.pathname === "/api/browser/shared")
      return Response.json({ interviews: await sharedWith(env, user.email) });
    // An interview someone else assigned to this user lives in their hub.
    const token = interviewToken(url.pathname);
    const share = token ? await shareFor(env, token) : null;
    // Whose workspace this request works in: the user's own, or, for an
    // interview of an account linked to theirs, that account's.
    let workspace = user.email.toLowerCase();
    if (share && share.owner !== workspace) {
      if (await samePerson(env, workspace, share.owner))
        workspace = share.owner;
      else return respond(request, env, user, share);
    }
    if (token && !share) {
      const where = await notHere(request, env, user, token);
      if (where instanceof Response) return where;
      if (where) workspace = where;
    }
    if (request.method === "POST" && BROWSER_ASSIGN.test(url.pathname))
      return assign(
        env,
        workspace,
        user.name ?? user.email,
        forwardable(request),
      );
    if (
      url.pathname.startsWith("/api/browser/") ||
      url.pathname.startsWith("/ws/")
    )
      return toHub(env, workspace, forwardable(request));
    // The interview list and each interview are the same app.
    if (url.pathname === "/" || url.pathname.startsWith("/s/"))
      return env.ASSETS.fetch(new Request(new URL("/index.html", url)));
    return env.ASSETS.fetch(request);
  },
};

/**
 * Who has signed up and on which plan, and an admin's comp: a form on the
 * page posts here, so check it is our own page.
 */
async function admin(request: Request, env: Env, user: User) {
  if (request.method === "POST") {
    if (!sameSite(request))
      return new Response("Cross-site request refused", { status: 403 });
    const form = await request.formData();
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email))
      return page(400, 'That isn\'t an email. <a href="/admin">Back</a>.');
    await setComp(
      env,
      email,
      form.get("plan") === "pro" ? "pro" : null,
      user.email,
    );
    // Name who changed, so the page can show it before KV's list catches up.
    return new Response(null, {
      status: 303,
      headers: { location: `/admin?changed=${encodeURIComponent(email)}` },
    });
  }
  if (new URL(request.url).pathname !== "/admin")
    return new Response("Not found", { status: 404 });
  const [users, plans] = await Promise.all([listUsers(env), listPlans(env)]);
  // KV's list can lag a write by a minute; read the one just changed directly.
  const changed = new URL(request.url).searchParams.get("changed");
  if (changed) {
    const record = await planRecord(env, changed);
    if (record) plans.set(changed.trim().toLowerCase(), record);
    else plans.delete(changed.trim().toLowerCase());
  }
  // Someone comped before they first sign in is listed too.
  for (const email of plans.keys())
    if (!users.some((listed) => listed.email === email)) users.push({ email });
  return adminPage(users, (email) => {
    const record = plans.get(email) ?? null;
    return { ...resolvePlan(env, email, record), record };
  });
}

/**
 * A request for an interview assigned to someone. Its assignee, or an
 * account linked to theirs, reaches it in the owner's hub, marked as the
 * assignee so the hub lets them see that one interview and nothing else,
 * and their answers carry the address it was sent to. Anyone else is told
 * whose it is.
 */
async function respond(request: Request, env: Env, user: User, share: Share) {
  const url = new URL(request.url);
  const isPage = url.pathname.startsWith("/s/");
  if (!(await samePerson(env, user.email, share.assignee))) {
    const masked = maskEmail(share.assignee);
    return elsewhereResponse(
      url,
      403,
      "sent-elsewhere",
      `This interview was sent to ${masked}. You're signed in as ${user.email}.`,
      `<form method="post" action="/auth/google/link"><input type="hidden" name="next" value="${escapeHtml(url.pathname)}"><button class="google" type="submit">Link ${escapeHtml(masked)} to this account</button></form>`,
    );
  }
  if (isPage) return env.ASSETS.fetch(new Request(new URL("/index.html", url)));
  const forwarded = forwardable(request);
  forwarded.headers.set(RESPONDENT_HEADER, share.assignee);
  return hubFor(env, share.owner).fetch(forwarded);
}

/**
 * An interview that isn't assigned, opened by someone other than its
 * owner: the token would reach their own workspace, which doesn't have it,
 * and the page would say it was deleted. So say whose it is (masked, to
 * someone holding the private link), or that it isn't here. Null when it
 * is the user's own.
 */
async function notHere(
  request: Request,
  env: Env,
  user: User,
  token: string,
): Promise<Response | string | null> {
  const url = new URL(request.url);
  const me = user.email.toLowerCase();
  const owner = await ownerOf(env, token);
  if (owner === me) return null;
  // Linked accounts are one person: open it in the other account's workspace.
  if (owner && (await samePerson(env, me, owner))) return owner;
  if (owner)
    return elsewhereResponse(
      url,
      403,
      "other-account",
      `This interview is in another account (${maskEmail(owner)}). You're signed in as ${user.email}.`,
    );
  // Not indexed: from before the index, or deleted. A page asks the user's
  // own workspace, then any linked account's, and remembers where it found
  // it; other calls go to the user's own, which answers for itself.
  if (!url.pathname.startsWith("/s/")) return null;
  // The user's own workspace first, then any linked account's.
  for (const email of await linkedEmails(env, me)) {
    const found = await hubFor(env, email).fetch(
      new Request(new URL(`/api/browser/${token}/session`, url)),
    );
    if (!found.ok) continue;
    await recordOwner(env, token, email);
    return email === me ? null : email;
  }
  return elsewhereResponse(
    url,
    404,
    "not-here",
    `This interview isn't in ${user.email}. It may be in another Google account you use, or it was deleted.`,
  );
}

/**
 * Why this account can't open an interview, in plain text: a page, with
 * Switch account and any other way in (HTML), or for the app's API calls
 * JSON with a code.
 */
function elsewhereResponse(
  url: URL,
  status: number,
  code: string,
  message: string,
  action = "",
) {
  if (!url.pathname.startsWith("/s/"))
    return Response.json({ error: message, code }, { status });
  return page(
    status,
    `${escapeHtml(message)}</p>
${action}
<p><a href="${signInUrl(url, true)}">Switch account</a>.`,
  );
}

/**
 * Google has already signed the user in, so authorization completes without
 * a consent page. Only the CLI's loopback callback may receive the code, so a
 * link from anyone else can't collect a token.
 */
async function authorize(request: Request, env: Env, user: User) {
  const oauth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const redirect = new URL(oauth.redirectUri);
  if (redirect.protocol !== "http:" || !isLoopback(redirect.hostname))
    return page(400, "Only the kim CLI can sign in here.");
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauth,
    userId: user.email,
    metadata: { label: "kim CLI" },
    scope: oauth.scope,
    props: { email: user.email },
  });
  return Response.redirect(redirectTo, 302);
}

/**
 * Routes anyone can call that write KV or start a sign-in: the CLI's client
 * registration, authorization and token swap, Google sign-in, and linking
 * or unlinking an account. A `kim login` calls each once or twice; a CLI
 * refreshes its token hourly.
 */
const RATE_LIMITED =
  /^\/(register|authorize|token|auth\/google\/(start|callback|link)|api\/browser\/links\/unlink)$/;

/** Requests a signed-in user makes that write KV: assigning, making a key. */
const KV_WRITES =
  /^\/api\/(sessions|browser)\/[^/]+\/assign$|^\/api\/sessions\/kim\/keys$/;

/**
 * A 429 once a signed-in user has made too many requests: any at all past
 * API_LIMITER's generous allowance, or the few that write KV past
 * AUTH_LIMITER's. Keyed by email, so one account can't run up the bill
 * from many addresses.
 */
async function userLimited(env: Env, email: string, request: Request) {
  const key = email.toLowerCase();
  const writes =
    request.method === "POST" && KV_WRITES.test(new URL(request.url).pathname);
  for (const [limiter, scoped] of [
    [env.API_LIMITER, key],
    [writes ? env.AUTH_LIMITER : undefined, `write:${key}`],
  ] as const) {
    if (limiter && !(await limiter.limit({ key: scoped })).success)
      return Response.json(
        { error: "Too many requests; try again in a minute" },
        { status: 429, headers: { "retry-after": "60" } },
      );
  }
  return null;
}

/** A 429 once a client IP has called the rate-limited routes too often. */
async function rateLimited(request: Request, env: Env) {
  if (!env.AUTH_LIMITER || !RATE_LIMITED.test(new URL(request.url).pathname))
    return null;
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.AUTH_LIMITER.limit({ key });
  if (success) return null;
  return Response.json(
    { error: "Too many sign-in attempts; try again in a minute" },
    { status: 429, headers: { "retry-after": "60" } },
  );
}

let provider: OAuthProvider<Env> | null = null;

export default {
  async fetch(request, env, ctx) {
    const limited = await rateLimited(request, env);
    if (limited) return limited;
    // Built on first use, because the resource URL comes from the environment.
    provider ??= new OAuthProvider<Env>({
      apiRoute: "/api/sessions",
      apiHandler: agentApi as ExportedHandlerWithFetch<Env>,
      defaultHandler: site as ExportedHandlerWithFetch<Env>,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      resourceMetadata: { resource: `${env.PUBLIC_URL}/api/sessions` },
      // Agent keys (`kim key create`) for places that can't sign in
      // through a browser, such as a cloud session's environment. Keys
      // made before there were other users have no owner recorded: they
      // are the owner's.
      resolveExternalToken: async ({ token, env, request }) => {
        if (!token.startsWith(KEY_PREFIX)) return null;
        const hash = await sha256(token);
        const recorded = await keyOwners.get(hash, () =>
          env.OAUTH_KV.get(keyOwner(hash)),
        );
        const email = recorded ?? env.OWNER_EMAIL;
        if (!email) return null;
        // Made-up keys all land here, on the owner's hub: limit them per
        // address, as sign-in is, so they can't flood it.
        if (!recorded && env.AUTH_LIMITER) {
          const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
          const { success } = await env.AUTH_LIMITER.limit({
            key: `key:${ip}`,
          });
          if (!success) return null;
        }
        const verdict = (await hubFor(env, email)
          .fetch("https://hub/internal/keys/verify", {
            method: "POST",
            body: JSON.stringify({ key: token }),
          })
          .then((response) => response.json())) as { ok?: boolean };
        if (!verdict.ok) return null;
        // An owner's key from before owners were recorded gets its record,
        // so it never takes the limited path again.
        if (!recorded) {
          keyOwners.set(hash, email);
          await env.OAUTH_KV.put(keyOwner(hash), email);
        }
        return {
          props: { email, via: "key" },
          audience: `${env.PUBLIC_URL}/api/sessions`,
        };
      },
      scopesSupported: ["interviews"],
      accessTokenTTL: 60 * 60,
      // A login lasts while the CLI keeps using it.
      refreshTokenTTL: 365 * 24 * 60 * 60,
      refreshTokenIdleTTL: 90 * 24 * 60 * 60,
    });
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

type ExportedHandlerWithFetch<E> = ExportedHandler<E> & {
  fetch: NonNullable<ExportedHandler<E>["fetch"]>;
};
