import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { accessEmail, isAllowed, isLoopback } from "./access.js";
import { KEY_PREFIX, VIA_KEY_HEADER } from "../server/features/keys.js";
import type { Env } from "./env.js";

export { InterviewHub } from "./hub.js";

const PUBLIC_FILES =
  /^\/(assets\/|icons\/|manifest\.webmanifest$|sw\.js$|cli\.tgz$)/;

/** Where an agent key downloads the CLI package. */
const CLI_PACKAGE_PATH = "/api/sessions/kim/cli.tgz";

const hub = (env: Env) => env.HUB.get(env.HUB.idFromName("interviews"));

const page = (status: number, message: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Keep it moving</title><p style="font:16px system-ui;margin:3rem">${message}</p>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** The agent API: OAuth access tokens issued to the CLI, for the allowed account only. */
const agentApi: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    const props = (
      ctx as ExecutionContext & { props?: { email?: string; via?: string } }
    ).props;
    if (!isAllowed(props?.email, env))
      return Response.json({ error: "Not allowed" }, { status: 403 });
    // The CLI package, for a cloud setup script holding the environment's
    // agent key: behind the token, so nothing new is public past Access.
    if (new URL(request.url).pathname === CLI_PACKAGE_PATH)
      return env.ASSETS.fetch(new Request(new URL("/cli.tgz", request.url)));
    // Tell the hub which requests a key made; a client can't claim either way.
    const forwarded = new Request(request);
    forwarded.headers.delete(VIA_KEY_HEADER);
    if (props?.via === "key") forwarded.headers.set(VIA_KEY_HEADER, "1");
    return hub(env).fetch(forwarded);
  },
};

/** Everything else: the OAuth authorize step, the browser UI, and its API, all behind Access. */
const site: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // Build output and app-install files hold nothing private, and Google's
    // servers fetch the icons without the Access cookie when installing. A
    // cloud environment's setup script installs the CLI from cli.tgz.
    if (PUBLIC_FILES.test(url.pathname)) return env.ASSETS.fetch(request);
    const email = await accessEmail(request, env);
    if (!isAllowed(email, env))
      return page(403, "This Keep it moving belongs to someone else.");
    if (url.pathname === "/authorize") return authorize(request, env, email!);
    if (
      url.pathname.startsWith("/api/browser/") ||
      url.pathname.startsWith("/ws/")
    )
      return hub(env).fetch(request);
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
 * Access has already signed the user in, so authorization completes without
 * a consent page. Only the CLI's loopback callback may receive the code, so a
 * link from anyone else can't collect a token.
 */
async function authorize(request: Request, env: Env, email: string) {
  const oauth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const redirect = new URL(oauth.redirectUri);
  if (redirect.protocol !== "http:" || !isLoopback(redirect.hostname))
    return page(400, "Only the kim CLI can sign in here.");
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauth,
    userId: email,
    metadata: { label: "kim CLI" },
    scope: oauth.scope,
    props: { email },
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
      // through a browser, such as a cloud session's environment.
      resolveExternalToken: async ({ token, env }) => {
        if (!token.startsWith(KEY_PREFIX)) return null;
        const verdict = (await hub(env)
          .fetch("https://hub/internal/keys/verify", {
            method: "POST",
            body: JSON.stringify({ key: token }),
          })
          .then((response) => response.json())) as { ok?: boolean };
        if (!verdict.ok) return null;
        return {
          props: { email: env.ALLOWED_EMAIL, via: "key" },
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
