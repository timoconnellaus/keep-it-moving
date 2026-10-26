import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GOOGLE_JWKS, GOOGLE_TOKEN } from "../src/worker/auth.js";
import type { Env } from "../src/worker/env.js";
import { isOwnerHub } from "../src/worker/hubs.js";
import worker from "../src/worker/index.js";
import { hubHarness } from "./helpers/harness.js";

const ORIGIN = "https://kim.test";
const OWNER = "owner@example.com";
const CLIENT_ID = "google-client";

let googleKey: CryptoKey;
/** Claims the fake Google puts in the next ID token, nonce aside. */
let nextClaims: JWTPayload = {};

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  googleKey = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  // Google's token endpoint and keys; nothing reaches the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === GOOGLE_JWKS) return Response.json({ keys: [jwk] });
      if (url === GOOGLE_TOKEN) {
        const form = new URLSearchParams(String(init?.body));
        if (form.get("code") !== "good-code")
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({
          id_token: await new SignJWT(nextClaims)
            .setProtectedHeader({ alg: "RS256", kid: "k1" })
            .setIssuer("https://accounts.google.com")
            .setAudience(CLIENT_ID)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(googleKey),
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
});
afterAll(() => vi.unstubAllGlobals());

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

/** KV in memory, enough for sessions, key owners and the OAuth provider. */
function memoryKv() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string, type?: string | { type?: string }) {
      const value = data.get(key) ?? null;
      const kind = typeof type === "string" ? type : type?.type;
      return value !== null && kind === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return {
        keys: [...data.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

/** The Worker with every binding faked: each hub name gets its own node:sqlite hub. */
function setup() {
  const hubs = new Map<string, ReturnType<typeof hubHarness>>();
  const idFromName = (name: string) => ({
    name,
    equals: (other: { name?: string }) => other.name === name,
    toString: () => name,
  });
  const kv = memoryKv();
  const env = {
    PUBLIC_URL: ORIGIN,
    OWNER_EMAIL: OWNER,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: "secret",
    OAUTH_KV: kv,
    ASSETS: {
      fetch: async (request: Request) =>
        new Response(`asset ${new URL(request.url).pathname}`),
    },
    HUB: {
      idFromName,
      get: ({ name }: { name: string }) => {
        let hub = hubs.get(name);
        if (!hub) {
          hub = hubHarness();
          hubs.set(name, hub);
          closers.push(() => hub!.sql.close());
        }
        const harness = hub;
        return {
          fetch: (input: RequestInfo, init?: RequestInit) =>
            harness.app.fetch(new Request(input, init)),
        };
      },
    },
  } as unknown as Env;
  const call = (
    path: string,
    init: RequestInit & { cookie?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    return worker.fetch(
      new Request(new URL(path, ORIGIN), { ...init, headers }),
      env,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        props: {},
      } as unknown as ExecutionContext,
    ) as Promise<Response>;
  };

  /** Google's half of the dance, ending at the callback. */
  const startAndReturn = async (
    claims: JWTPayload,
    options: { next?: string; tamper?: boolean } = {},
  ) => {
    const start = await call(
      `/auth/google/start?next=${encodeURIComponent(options.next ?? "/")}`,
    );
    const google = new URL(start.headers.get("location")!);
    const flow = cookiesOf(start);
    nextClaims = { nonce: google.searchParams.get("nonce")!, ...claims };
    const state = options.tamper ? "forged" : google.searchParams.get("state");
    return call(`/auth/google/callback?code=good-code&state=${state}`, {
      cookie: flow,
    });
  };
  const signIn = async (email: string) => {
    const back = await startAndReturn({ email, email_verified: true });
    expect(back.status).toBe(302);
    return cookiesOf(back);
  };

  /** `kim login`: register, authorize with the browser session, swap the code. */
  const cliToken = async (cookie: string) => {
    const redirectUri = "http://127.0.0.1:4567/callback";
    const { client_id: clientId } = (await (
      await call("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "kim",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      })
    ).json()) as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const authorize = await call(
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "interviews",
        state: "s",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      })}`,
      { cookie },
    );
    const code = new URL(authorize.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const token = (await (
      await call("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        }),
      })
    ).json()) as { access_token: string };
    return token.access_token;
  };
  const bearer = (token: string) => ({
    headers: { authorization: `Bearer ${token}` },
  });

  return { env, kv, hubs, call, startAndReturn, signIn, cliToken, bearer };
}

/** The Set-Cookie values, as the browser would send them back. */
const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");

describe("Google sign-in", () => {
  it("sends a signed-out page to sign in, and API calls get a 401", async () => {
    const { call } = setup();
    const home = await call("/p/abc?tab=prs");
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe(
      `${ORIGIN}/signin?next=%2Fp%2Fabc%3Ftab%3Dprs`,
    );
    const signin = await call("/signin?next=%2Fp%2Fabc");
    expect(await signin.text()).toContain(
      'href="/auth/google/start?next=%2Fp%2Fabc"',
    );
    expect((await call("/api/browser/overview")).status).toBe(401);
    expect((await call("/ws/overview")).status).toBe(401);
    // Install files stay public.
    expect((await call("/manifest.webmanifest")).status).toBe(200);
  });

  it("starts with state, nonce and PKCE, and comes back to `next`", async () => {
    const { call, signIn, startAndReturn } = setup();
    const start = await call("/auth/google/start?next=/s/tok");
    const google = new URL(start.headers.get("location")!);
    expect(google.origin + google.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(google.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/auth/google/callback`,
    );
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    expect(start.headers.get("set-cookie")).toMatch(/HttpOnly; Secure/);

    const back = await startAndReturn(
      { email: "Ann@Example.com", email_verified: true, name: "Ann" },
      { next: "/s/tok" },
    );
    expect(back.headers.get("location")).toBe("/s/tok");
    const cookie = cookiesOf(back);
    expect((await call("/s/tok", { cookie })).status).toBe(200);
    expect(await (await call("/api/browser/me", { cookie })).json()).toEqual({
      email: "ann@example.com",
      name: "Ann",
    });
    expect(await signIn("bob@example.com")).not.toBe(cookie);
  });

  it("won't send the browser off-site after sign-in", async () => {
    const { startAndReturn } = setup();
    const back = await startAndReturn(
      { email: "ann@example.com", email_verified: true },
      { next: "//evil.example/x" },
    );
    expect(back.headers.get("location")).toBe("/");
  });

  it("rejects a callback whose state isn't ours", async () => {
    const { call, startAndReturn } = setup();
    const back = await startAndReturn(
      { email: "ann@example.com", email_verified: true },
      { tamper: true },
    );
    expect(back.status).toBe(400);
    expect(back.headers.getSetCookie()).toEqual([]);
    // And one with no flow cookie at all.
    const bare = await call("/auth/google/callback?code=good-code&state=x");
    expect(bare.status).toBe(400);
  });

  it("rejects an unverified email or a wrong nonce", async () => {
    const { startAndReturn } = setup();
    const unverified = await startAndReturn({
      email: "ann@example.com",
      email_verified: false,
    });
    expect(unverified.status).toBe(403);
    expect(unverified.headers.getSetCookie()).toEqual([]);
    const replayed = await startAndReturn({
      email: "ann@example.com",
      email_verified: true,
      nonce: "someone-elses",
    });
    expect(replayed.status).toBe(400);
  });

  it("signs out", async () => {
    const { call, signIn } = setup();
    const cookie = await signIn("ann@example.com");
    const out = await call("/auth/logout", {
      method: "POST",
      cookie,
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(out.status).toBe(303);
    expect((await call("/api/browser/me", { cookie })).status).toBe(401);
  });

  it("refuses a sign-out another site posts", async () => {
    const { call, signIn } = setup();
    const cookie = await signIn("ann@example.com");
    const out = await call("/auth/logout", {
      method: "POST",
      cookie,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(out.status).toBe(403);
    expect((await call("/api/browser/me", { cookie })).status).toBe(200);
  });
});

describe("one workspace per user", () => {
  it("keeps the owner on the original hub and everyone else on their own", async () => {
    const { env, hubs, call, signIn } = setup();
    const owner = await signIn("Owner@Example.com");
    const ann = await signIn("ann@example.com");
    await call("/api/browser/overview", { cookie: owner });
    await call("/api/browser/overview", { cookie: ann });
    expect([...hubs.keys()].sort()).toEqual([
      "interviews",
      "user:ann@example.com",
    ]);
    expect(isOwnerHub(env, env.HUB.idFromName("interviews"))).toBe(true);
    expect(isOwnerHub(env, env.HUB.idFromName("user:ann@example.com"))).toBe(
      false,
    );
  });

  it("doesn't show one user's interviews to another", async () => {
    const { call, signIn, cliToken, bearer } = setup();
    const ann = await signIn("ann@example.com");
    const bob = await signIn("bob@example.com");
    const annToken = await cliToken(ann);
    const created = (await (
      await call("/api/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${annToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "Ann's plan" }),
      })
    ).json()) as { id: string; url: string };
    const token = new URL(created.url).pathname.split("/").pop()!;

    const titles = async (cookie: string) =>
      (
        (await (await call("/api/browser/overview", { cookie })).json()) as {
          sessions: Array<{ title: string }>;
        }
      ).sessions.map((session) => session.title);
    expect(await titles(ann)).toEqual(["Ann's plan"]);
    expect(await titles(bob)).toEqual([]);
    expect(
      (await call(`/api/browser/${token}/session`, { cookie: bob })).status,
    ).toBe(404);
    expect(
      (await call(`/api/browser/${token}/session`, { cookie: ann })).status,
    ).toBe(200);
    // Bob's CLI can't reach it either.
    const bobToken = await cliToken(bob);
    expect(
      (await call(`/api/sessions/${created.id}`, bearer(bobToken))).status,
    ).toBe(404);
  });
});

describe("kim login", () => {
  it("sends /authorize through Google sign-in and back when signed out", async () => {
    const { call } = setup();
    const path = "/authorize?response_type=code&client_id=c";
    const response = await call(path);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/auth/google/start?next=${encodeURIComponent(path)}`,
    );
  });
});

describe("agent keys", () => {
  const createKey = async (
    s: ReturnType<typeof setup>,
    token: string,
    name: string,
  ) =>
    (
      (await (
        await s.call("/api/sessions/kim/keys", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name }),
        })
      ).json()) as { key: string }
    ).key;

  it("authenticates a user's key as that user", async () => {
    const s = setup();
    const ann = await s.signIn("ann@example.com");
    const key = await createKey(s, await s.cliToken(ann), "ann cloud");
    await s.call("/api/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "From Ann's cloud" }),
    });
    const titles = (
      (await (
        await s.call("/api/browser/overview", { cookie: ann })
      ).json()) as { sessions: Array<{ title: string }> }
    ).sessions.map((session) => session.title);
    expect(titles).toEqual(["From Ann's cloud"]);
    expect(s.hubs.has("interviews")).toBe(false);
  });

  it("keeps the owner's keys from before working, and refuses unknown keys", async () => {
    const s = setup();
    // A key made before keys recorded their owner: only the owner's hub knows it.
    const legacy = (await (
      await s.env.HUB.get(s.env.HUB.idFromName("interviews")).fetch(
        "https://hub/api/sessions/kim/keys",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "old cloud" }),
        },
      )
    ).json()) as { key: string };
    expect([...s.kv.data.keys()].some((k) => k.startsWith("agent-key:"))).toBe(
      false,
    );
    expect((await s.call("/api/sessions", s.bearer(legacy.key))).status).toBe(
      200,
    );
    expect(
      (await s.call("/api/sessions", s.bearer("kim_not-a-real-key"))).status,
    ).toBe(401);
  });
});
