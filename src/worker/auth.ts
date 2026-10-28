import { createRemoteJWKSet, jwtVerify } from "jose";
import { sameSite } from "../server/hub.js";
import { ttlCache } from "./cache.js";
import type { Env } from "./env.js";
import { page } from "./pages.js";
import { saveProfile } from "./shares.js";

/** Who is signed in to the browser, as Google told us at sign-in. */
export interface User {
  email: string;
  name?: string;
  picture?: string;
}

export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** The browser session's id; the session itself lives in KV. */
const SESSION_COOKIE = "__Host-kim_session";
/** State, nonce and PKCE verifier between leaving for Google and coming back. */
const FLOW_COOKIE = "__Host-kim_google";
const SESSION_TTL = 30 * 24 * 60 * 60;
const FLOW_TTL = 10 * 60;
/** A session in use is extended at most this often, to keep KV writes rare. */
const REFRESH_MS = 24 * 60 * 60 * 1000;

let googleKeys: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * The signed-in user, or null. On localhost DEV_EMAIL stands in for Google,
 * so `wrangler dev` needs no OAuth client.
 */
export async function currentUser(
  request: Request,
  env: Env,
): Promise<User | null> {
  if (env.DEV_EMAIL && isLoopback(new URL(request.url).hostname))
    return { email: env.DEV_EMAIL };
  const id = cookie(request, SESSION_COOKIE);
  if (!id) return null;
  const stored = await sessions.get(id, () =>
    env.OAUTH_KV.get<StoredSession>(`session:${id}`, "json"),
  );
  if (!stored) return null;
  const { refreshed, ...user } = stored;
  // Sliding expiry: a session lasts while it keeps being used.
  if (Date.now() - refreshed > REFRESH_MS) await saveSession(env, id, user);
  return user;
}

/** Sends the browser to Google, remembering where to come back to. */
export async function googleStart(request: Request, env: Env) {
  if (!env.GOOGLE_CLIENT_ID) return notSetUp();
  const url = new URL(request.url);
  // Sign in on the public origin, where the callback and cookies live.
  const origin = callbackOrigin(url, env);
  if (url.origin !== origin)
    return Response.redirect(`${origin}${url.pathname}${url.search}`, 302);
  const flow = {
    state: random(),
    nonce: random(),
    verifier: random(),
    next: safeNext(url.searchParams.get("next")),
  };
  const google = new URL(GOOGLE_AUTHORIZE);
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await challenge(flow.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return redirect(google.toString(), [
    setCookie(FLOW_COOKIE, encode(flow), FLOW_TTL),
  ]);
}

/** Google's redirect back: checks it, then starts a browser session. */
export async function googleCallback(request: Request, env: Env) {
  // Without it jwtVerify would skip the audience check.
  if (!env.GOOGLE_CLIENT_ID) return notSetUp();
  const url = new URL(request.url);
  const flow = decode(cookie(request, FLOW_COOKIE));
  const code = url.searchParams.get("code");
  if (!flow || !code || url.searchParams.get("state") !== flow.state)
    return page(400, signInAgain("That sign-in link expired or was not ours."));
  const tokens = (await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: `${callbackOrigin(url, env)}/auth/google/callback`,
      grant_type: "authorization_code",
      code_verifier: flow.verifier,
    }),
  })
    .then((response) => response.json())
    .catch(() => ({}))) as { id_token?: string };
  if (!tokens.id_token)
    return page(502, signInAgain("Google didn't complete the sign-in."));
  let claims;
  try {
    googleKeys ??= createRemoteJWKSet(new URL(GOOGLE_JWKS));
    ({ payload: claims } = await jwtVerify(tokens.id_token, googleKeys, {
      issuer: GOOGLE_ISSUERS,
      audience: env.GOOGLE_CLIENT_ID,
    }));
  } catch {
    return page(400, signInAgain("Google's answer didn't check out."));
  }
  if (claims.nonce !== flow.nonce)
    return page(400, signInAgain("That sign-in link was not ours."));
  if (typeof claims.email !== "string" || claims.email_verified !== true)
    return page(403, signInAgain("That Google account has no verified email."));
  const user: User = { email: claims.email.toLowerCase() };
  if (typeof claims.name === "string") user.name = claims.name;
  if (typeof claims.picture === "string") user.picture = claims.picture;
  const id = random();
  await saveSession(env, id, user);
  if (user.name) await saveProfile(env, user.email, user.name);
  return redirect(flow.next, [
    setCookie(SESSION_COOKIE, id, SESSION_TTL),
    setCookie(FLOW_COOKIE, "", 0),
  ]);
}

/** Ends the browser session; a form posts here, so check it is our own page. */
export async function logout(request: Request, env: Env) {
  if (!sameSite(request))
    return new Response("Cross-site request refused", { status: 403 });
  const id = cookie(request, SESSION_COOKIE);
  if (id) {
    sessions.delete(id);
    await env.OAUTH_KV.delete(`session:${id}`);
  }
  return redirect("/signin", [setCookie(SESSION_COOKIE, "", 0)], 303);
}

/** Where a signed-out visitor to `url` goes to sign in and come back. */
export const signInUrl = (url: URL, start = false) =>
  `${start ? "/auth/google/start" : "/signin"}?next=${encodeURIComponent(url.pathname + url.search)}`;

/** Only a path on this site, so sign-in can't bounce the browser elsewhere. */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || /^\/[/\\]/.test(next)) return "/";
  return next;
}

export function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

/** The public origin, or the request's own on localhost for `wrangler dev`. */
const callbackOrigin = (url: URL, env: Env) =>
  isLoopback(url.hostname) ? url.origin : new URL(env.PUBLIC_URL).origin;

const notSetUp = () =>
  page(
    503,
    "Google sign-in isn't set up on this deployment: GOOGLE_CLIENT_ID is missing.",
  );

const signInAgain = (message: string) =>
  `${message} <a href="/signin">Sign in again</a>.`;

type StoredSession = User & { refreshed: number };

/**
 * Sessions read in this isolate lately. A sign-out elsewhere reaches it
 * within the TTL.
 */
const sessions = ttlCache<StoredSession | null>(30_000);

async function saveSession(env: Env, id: string, user: User) {
  const stored: StoredSession = { ...user, refreshed: Date.now() };
  sessions.set(id, stored);
  await env.OAUTH_KV.put(`session:${id}`, JSON.stringify(stored), {
    expirationTtl: SESSION_TTL,
  });
}

function redirect(location: string, cookies: string[], status = 302) {
  const headers = new Headers({ location });
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { status, headers });
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
}

const encode = (flow: Flow) =>
  base64url(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(flow))),
  );

function decode(value: string | null): Flow | null {
  if (!value) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const flow = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      ),
    ) as Partial<Flow>;
    return typeof flow.state === "string" &&
      typeof flow.nonce === "string" &&
      typeof flow.verifier === "string"
      ? { ...(flow as Flow), next: safeNext(flow.next ?? null) }
      : null;
  } catch {
    return null;
  }
}

/** 32 random bytes, base64url. */
const random = () =>
  base64url(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

async function challenge(verifier: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(String.fromCharCode(...new Uint8Array(digest)));
}

const base64url = (binary: string) =>
  btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
