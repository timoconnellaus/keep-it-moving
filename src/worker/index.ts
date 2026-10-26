import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import {
  currentUser,
  googleCallback,
  googleStart,
  isLoopback,
  logout,
  safeNext,
  signInUrl,
  type User,
} from "./auth.js";
import { KEY_PREFIX, sha256, VIA_KEY_HEADER } from "../server/features/keys.js";
import type { Env } from "./env.js";
import { hubFor } from "./hubs.js";
import { page, signInPage } from "./pages.js";

export { InterviewHub } from "./hub.js";

const PUBLIC_FILES =
  /^\/(assets\/|icons\/|manifest\.webmanifest$|sw\.js$|cli\.tgz$)/;

/** Where an agent key downloads the CLI package. */
const CLI_PACKAGE_PATH = "/api/sessions/kim/cli.tgz";

/** Which user an agent key belongs to, by the key's hash. */
const keyOwner = (hash: string) => `agent-key:${hash}`;

/** The agent API: OAuth access tokens issued to the CLI, each routed to its user's workspace. */
const agentApi: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const props = (
      ctx as ExecutionContext & { props?: { email?: string; via?: string } }
    ).props;
    const email = props?.email;
    if (!email) return Response.json({ error: "Not allowed" }, { status: 403 });
    // The CLI package, for a cloud setup script holding the environment's
    // agent key: behind the token, so nothing new is public.
    const path = new URL(request.url).pathname;
    if (path === CLI_PACKAGE_PATH)
      return env.ASSETS.fetch(new Request(new URL("/cli.tgz", request.url)));
    // Tell the hub which requests a key made; a client can't claim either way.
    const forwarded = new Request(request);
    forwarded.headers.delete(VIA_KEY_HEADER);
    if (props.via === "key") forwarded.headers.set(VIA_KEY_HEADER, "1");
    const response = await hubFor(env, email).fetch(forwarded);
    // A new key remembers whose it is, so it reaches the same workspace.
    if (
      request.method === "POST" &&
      path === "/api/sessions/kim/keys" &&
      response.ok
    ) {
      const { key } = (await response.clone().json()) as { key?: string };
      if (key) await env.OAUTH_KV.put(keyOwner(await sha256(key)), email);
    }
    return response;
  },
};

/** Everything else: Google sign-in, the OAuth authorize step, the browser UI, and its API. */
const site: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // Build output and app-install files hold nothing private, and Google's
    // servers fetch the icons without a sign-in when installing. A cloud
    // environment's setup script installs the CLI from cli.tgz.
    if (PUBLIC_FILES.test(url.pathname)) return env.ASSETS.fetch(request);
    if (url.pathname === "/auth/google/start") return googleStart(request, env);
    if (url.pathname === "/auth/google/callback")
      return googleCallback(request, env);
    if (url.pathname === "/auth/logout" && request.method === "POST")
      return logout(request, env);
    const user = await currentUser(request, env);
    if (url.pathname === "/signin")
      return user
        ? Response.redirect(
            new URL(safeNext(url.searchParams.get("next")), url).toString(),
            302,
          )
        : signInPage(safeNext(url.searchParams.get("next")));
    if (!user) {
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
    if (url.pathname === "/api/browser/me") return Response.json(user);
    if (
      url.pathname.startsWith("/api/browser/") ||
      url.pathname.startsWith("/ws/")
    )
      return hubFor(env, user.email).fetch(request);
    // The inbox, each project page and each interview are the same app.
    if (
      url.pathname === "/" ||
      url.pathname.startsWith("/s/") ||
      url.pathname.startsWith("/p/")
    )
      return env.ASSETS.fetch(new Request(new URL("/index.html", url)));
    return env.ASSETS.fetch(request);
  },
};

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

let provider: OAuthProvider<Env> | null = null;

export default {
  fetch(request, env, ctx) {
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
      resolveExternalToken: async ({ token, env }) => {
        if (!token.startsWith(KEY_PREFIX)) return null;
        const email =
          (await env.OAUTH_KV.get(keyOwner(await sha256(token)))) ??
          env.OWNER_EMAIL;
        const verdict = (await hubFor(env, email)
          .fetch("https://hub/internal/keys/verify", {
            method: "POST",
            body: JSON.stringify({ key: token }),
          })
          .then((response) => response.json())) as { ok?: boolean };
        if (!verdict.ok) return null;
        return {
          props: { email, via: "key" },
          audience: `${env.PUBLIC_URL}/api/sessions`,
        };
      },
      scopesSupported: ["interviews"],
      accessTokenTTL: 60 * 60,
      // A login lasts while the CLI keeps using it.
      refreshTokenTTL: 365 * 24 * 60 * 60,
      refreshTokenIdleTTL: 30 * 24 * 60 * 60,
    });
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

type ExportedHandlerWithFetch<E> = ExportedHandler<E> & {
  fetch: NonNullable<ExportedHandler<E>["fetch"]>;
};
