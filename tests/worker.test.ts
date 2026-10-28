import { createHash, createHmac, randomBytes } from "node:crypto";
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
import worker from "../src/worker/index.js";
import { plans, updatePlan } from "../src/worker/plans.js";
import { STRIPE_API } from "../src/worker/stripe.js";
import { ACCEPTED_SOCKET, hubHarness } from "./helpers/harness.js";

const ORIGIN = "https://kim.test";
const OWNER = "owner@example.com";
const CLIENT_ID = "google-client";

let googleKey: CryptoKey;
/** Claims the fake Google puts in the next ID token, nonce aside. */
let nextClaims: JWTPayload = {};
/** Stripe's API as the tests fake it, and what was sent to it. */
let stripeApi: (path: string, form: URLSearchParams) => Response = () =>
  Response.json({ error: { message: "No Stripe here" } }, { status: 500 });
const stripeCalls: Array<{ path: string; form: URLSearchParams }> = [];

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
      if (url.startsWith(STRIPE_API)) {
        const path = url.slice(STRIPE_API.length);
        const form = new URLSearchParams(String(init?.body ?? ""));
        stripeCalls.push({ path, form });
        return stripeApi(path, form);
      }
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
  const metadata = new Map<string, unknown>();
  return {
    data,
    async get(key: string, type?: string | { type?: string }) {
      const value = data.get(key) ?? null;
      const kind = typeof type === "string" ? type : type?.type;
      return value !== null && kind === "json" ? JSON.parse(value) : value;
    },
    async getWithMetadata(key: string) {
      return {
        value: data.get(key) ?? null,
        metadata: metadata.get(key) ?? null,
      };
    },
    async put(key: string, value: string, options?: { metadata?: unknown }) {
      data.set(key, value);
      metadata.set(key, options?.metadata);
    },
    async delete(key: string) {
      data.delete(key);
      metadata.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return {
        keys: [...data.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name, metadata: metadata.get(name) })),
        list_complete: true,
      };
    },
  };
}

/** The Worker with every binding faked: each hub name gets its own node:sqlite hub. */
function setup() {
  // Each test starts with nobody's plan cached.
  plans.clear();
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
    ADMIN_EMAILS: "Admin@Example.com, other@example.com",
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
          closers.push(() => {
            // Open agent sockets would be reviewed after the database closes.
            for (const socket of hub!.agents.list()) socket.disconnect();
            hub!.sql.close();
          });
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

  /** Puts someone on Pro, as a paid Stripe subscription would. */
  const pro = (email: string) =>
    updatePlan(env, email, (record) => ({
      ...record,
      plan: "pro",
      status: "active",
    }));

  return { env, kv, hubs, call, startAndReturn, signIn, cliToken, bearer, pro };
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
    const home = await call("/s/abc?view=plan");
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe(
      `${ORIGIN}/signin?next=%2Fs%2Fabc%3Fview%3Dplan`,
    );
    const signin = await call("/signin?next=%2Fs%2Fabc");
    const signinHtml = await signin.text();
    expect(signinHtml).toContain('href="/auth/google/start?next=%2Fs%2Fabc"');
    // How to get the CLI and skill, from this deployment.
    expect(signinHtml).toContain(`npm install -g ${ORIGIN}/cli.tgz`);
    expect(signinHtml).toContain(
      'href="https://github.com/timoconnellaus/keep-it-moving"',
    );
    expect((await call("/api/browser/overview")).status).toBe(401);
    expect((await call("/ws/overview")).status).toBe(401);
    // Install files stay public.
    expect((await call("/manifest.webmanifest")).status).toBe(200);
    expect((await call("/cli-version.json")).status).toBe(200);
  });

  it("refuses sign-in when GOOGLE_CLIENT_ID isn't set", async () => {
    const { env, call } = setup();
    delete (env as { GOOGLE_CLIENT_ID?: string }).GOOGLE_CLIENT_ID;
    expect((await call("/auth/google/start")).status).toBe(503);
    expect((await call("/auth/google/callback?code=c&state=s")).status).toBe(
      503,
    );
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
      plan: { plan: "free", source: null, billing: false, manageable: false },
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

describe("the admin page", () => {
  it("lists who signed up for ADMIN_EMAILS, and is not found for anyone else", async () => {
    const { kv, call, signIn } = setup();
    // Signed in before records began: a profile, no dates.
    await kv.put("profile:early@example.com", "Early");
    const ann = await signIn("ann@example.com");
    const admin = await signIn("admin@example.com");

    expect((await call("/admin", { cookie: ann })).status).toBe(404);
    const page = await call("/admin", { cookie: admin });
    expect(page.status).toBe(200);
    const html = await page.text();
    for (const email of [
      "ann@example.com",
      "admin@example.com",
      "early@example.com",
    ])
      expect(html).toContain(`<td>${email}</td>`);
    expect(html).toContain("3 people");
    expect((await call("/admin")).status).toBe(302);
  });
});

describe("one workspace per user", () => {
  it("keeps the owner on the original hub and everyone else on their own", async () => {
    const { hubs, call, signIn } = setup();
    const owner = await signIn("Owner@Example.com");
    const ann = await signIn("ann@example.com");
    await call("/api/browser/overview", { cookie: owner });
    await call("/api/browser/overview", { cookie: ann });
    expect([...hubs.keys()].sort()).toEqual([
      "interviews",
      "user:ann@example.com",
    ]);
  });

  it("gives everyone their own hub when there's no OWNER_EMAIL", async () => {
    const { env, hubs, call, signIn } = setup();
    delete (env as { OWNER_EMAIL?: string }).OWNER_EMAIL;
    const owner = await signIn("Owner@Example.com");
    await call("/api/browser/overview", { cookie: owner });
    expect([...hubs.keys()]).toEqual(["user:owner@example.com"]);
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

describe("assigning an interview to someone else", () => {
  /** Ann's interview with two questions, assigned to Bob. */
  async function assigned() {
    const s = setup();
    await s.pro("ann@example.com");
    const ann = await s.signIn("ann@example.com");
    const bob = await s.signIn("bob@example.com");
    const annToken = await s.cliToken(ann);
    const agent = (path: string, init: RequestInit = {}) =>
      s.call(path, {
        ...init,
        headers: {
          authorization: `Bearer ${annToken}`,
          "content-type": "application/json",
        },
      });
    const session = (await (
      await agent("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "Venue survey" }),
      })
    ).json()) as { id: string; token: string };
    const { questions } = (await (
      await agent(`/api/sessions/${session.id}/questions`, {
        method: "POST",
        body: JSON.stringify([{ prompt: "Which room?" }, { prompt: "When?" }]),
      })
    ).json()) as { questions: Array<{ id: string }> };
    const assignment = await agent(`/api/sessions/${session.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ email: "Bob@Example.com" }),
    });
    expect(assignment.status).toBe(200);
    expect(await assignment.json()).toMatchObject({
      assignee: "bob@example.com",
      url: expect.stringMatching(new RegExp(`/s/${session.token}$`)),
    });
    const asBob = (path: string, init: RequestInit = {}) =>
      s.call(path, {
        ...init,
        cookie: bob,
        headers: { "content-type": "application/json", ...init.headers },
      });
    return { ...s, ann, bob, agent, asBob, session, questions };
  }

  it("lets the assignee see, answer and chat on it, and nothing else", async () => {
    const { asBob, session, questions } = await assigned();
    const base = `/api/browser/${session.token}`;
    expect((await asBob(`/s/${session.token}`)).status).toBe(200);
    const view = await (await asBob(`${base}/session`)).json();
    expect(view).toMatchObject({
      title: "Venue survey",
      respondent: true,
      project: null,
      assignee: "bob@example.com",
      assignedBy: "ann@example.com",
    });
    expect(
      (
        await asBob(`${base}/questions/${questions[0]!.id}/answer`, {
          method: "POST",
          body: JSON.stringify({ answer: "The big one" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await asBob(`${base}/chat`, {
          method: "POST",
          body: JSON.stringify({ text: "Is parking included?" }),
        })
      ).status,
    ).toBe(200);
    // Owner-only routes with the token, even through the Worker, are refused.
    expect(
      (
        await asBob(`${base}/assign`, {
          method: "POST",
          body: JSON.stringify({ email: "bob2@example.com" }),
        })
      ).status,
    ).toBe(403);
  });

  it("brings the assignee's answers back to the owner's agent, attributed", async () => {
    const { asBob, agent, session, questions } = await assigned();
    await asBob(
      `/api/browser/${session.token}/questions/${questions[0]!.id}/answer`,
      { method: "POST", body: JSON.stringify({ answer: "The big one" }) },
    );
    const batch = await (
      await agent(`/api/sessions/${session.id}/wait?idle=0&timeout=5000`)
    ).json();
    expect(batch.answers).toEqual([
      expect.objectContaining({
        answer: "The big one",
        answeredBy: "bob@example.com",
      }),
    ]);
  });

  it("refuses anyone else, naming whose it is", async () => {
    const { call, signIn, session } = await assigned();
    const carol = await signIn("carol@example.com");
    const page = await call(`/s/${session.token}`, { cookie: carol });
    expect(page.status).toBe(403);
    const text = await page.text();
    expect(text).toContain("b•••@example.com");
    expect(text).toContain("Switch account");
    expect(text).not.toContain("bob@example.com");
    // A forged respondent header changes nothing.
    const forged = await call(`/api/browser/${session.token}/session`, {
      cookie: carol,
      headers: { "x-kim-respondent": "bob@example.com" },
    });
    expect(forged.status).toBe(403);
  });

  it("keeps the assignee out of the rest of the owner's workspace", async () => {
    const { asBob, session } = await assigned();
    // Bob's own list is his own (empty) workspace, header or not.
    for (const headers of [{}, { "x-kim-respondent": "bob@example.com" }]) {
      const overview = await (
        await asBob("/api/browser/overview", { headers })
      ).json();
      expect(overview.sessions).toEqual([]);
    }
    // A signed-out visitor goes through sign-in and back to the interview.
    const { call } = setup();
    const out = await call(`/s/${session.token}`);
    expect(out.headers.get("location")).toBe(
      `${ORIGIN}/signin?next=${encodeURIComponent(`/s/${session.token}`)}`,
    );
  });

  it("locks the assignee out on unassign, even before the directory catches up", async () => {
    const { agent, asBob, kv, session } = await assigned();
    const share = kv.data.get(`share:${session.token}`)!;
    await agent(`/api/sessions/${session.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ email: null }),
    });
    expect(kv.data.has(`share:${session.token}`)).toBe(false);
    expect(kv.data.has(`assigned:bob@example.com:${session.token}`)).toBe(
      false,
    );
    expect((await asBob(`/api/browser/${session.token}/session`)).status).toBe(
      404,
    );
    // A stale directory entry, as another isolate may have cached it, still
    // reaches the owner's hub, which says no.
    kv.data.set(`share:${session.token}`, share);
    const later = Date.now() + 31_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect((await asBob(`/api/browser/${session.token}/session`)).status).toBe(
      403,
    );
    vi.mocked(Date.now).mockRestore();
  });

  it("lists it under Shared with you, and forgets it when deleted", async () => {
    const { agent, asBob, kv, session } = await assigned();
    expect(await (await asBob("/api/browser/shared")).json()).toEqual({
      interviews: [
        {
          token: session.token,
          title: "Venue survey",
          from: "ann@example.com",
        },
      ],
    });
    await agent(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(kv.data.has(`share:${session.token}`)).toBe(false);
    expect(await (await asBob("/api/browser/shared")).json()).toEqual({
      interviews: [],
    });
  });

  it("doesn't count its open questions as needing the owner", async () => {
    const { ann, call } = await assigned();
    const overview = await (
      await call("/api/browser/overview", { cookie: ann })
    ).json();
    expect(overview.sessions[0]).toMatchObject({
      open: 0,
      assignee: "bob@example.com",
    });
  });

  it("won't assign an interview to its owner", async () => {
    const { agent, session } = await assigned();
    const response = await agent(`/api/sessions/${session.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ email: "ann@example.com" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("agent sockets through the Worker", () => {
  it("reaches the user's hub with a token, and refuses without one", async () => {
    const s = setup();
    const token = await s.cliToken(await s.signIn("ann@example.com"));
    const session = (await (
      await s.call("/api/sessions", { method: "POST", ...s.bearer(token) })
    ).json()) as { id: string };
    const upgrade = { upgrade: "websocket" };
    const accepted = await s.call(`/api/sessions/${session.id}/socket`, {
      headers: { ...upgrade, authorization: `Bearer ${token}` },
    });
    expect(accepted.headers.get(ACCEPTED_SOCKET)).toBe("1");
    const hub = s.hubs.get("user:ann@example.com")!;
    expect(hub.agents.list(session.id)).toHaveLength(1);
    const refused = await s.call(`/api/sessions/${session.id}/socket`, {
      headers: upgrade,
    });
    expect(refused.status).toBe(401);
  });
});

describe("rate limits", () => {
  /** A Rate Limiting binding allowing `limit` calls per key. */
  function limiter(limit: number) {
    const counts = new Map<string, number>();
    return {
      limit: vi.fn(async ({ key }: { key: string }) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return { success: counts.get(key)! <= limit };
      }),
    };
  }

  it("answers 429 once an IP registers or starts sign-in too often", async () => {
    const s = setup();
    const binding = limiter(2);
    Object.assign(s.env, { AUTH_LIMITER: binding });
    const from = (ip: string) => ({ headers: { "cf-connecting-ip": ip } });
    expect((await s.call("/auth/google/start", from("1.1.1.1"))).status).toBe(
      302,
    );
    const register = () =>
      s.call("/register", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "1.1.1.1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          redirect_uris: ["http://127.0.0.1:4567/callback"],
          token_endpoint_auth_method: "none",
        }),
      });
    expect((await register()).status).toBe(201);
    const refused = await register();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(
      (await s.call("/auth/google/callback", from("1.1.1.1"))).status,
    ).toBe(429);
    // Another address, and every other route, carry on.
    expect((await s.call("/auth/google/start", from("2.2.2.2"))).status).toBe(
      302,
    );
    expect((await s.call("/health", from("1.1.1.1"))).status).toBe(200);
    expect(binding.limit).toHaveBeenCalledTimes(5);
  });
});

describe("KV reads", () => {
  it("reads a browser session and a share from KV once, not per request", async () => {
    const s = setup();
    const cookie = await s.signIn("ann@example.com");
    const token = await s.cliToken(cookie);
    const session = (await (
      await s.call("/api/sessions", { method: "POST", ...s.bearer(token) })
    ).json()) as { token: string };
    const get = vi.spyOn(s.kv, "get");
    for (let index = 0; index < 5; index++)
      expect(
        (await s.call(`/api/browser/${session.token}/session`, { cookie }))
          .status,
      ).toBe(200);
    const keys = get.mock.calls.map(([key]) => key.split(":")[0]);
    expect(keys.filter((key) => key === "session")).toHaveLength(0);
    expect(keys.filter((key) => key === "share")).toHaveLength(1);
  });
});

describe("plans through the Worker", () => {
  /** A signed-in user's CLI, sending whatever headers it likes. */
  async function agentOf(s: ReturnType<typeof setup>, email: string) {
    const token = await s.cliToken(await s.signIn(email));
    return (path: string, init: RequestInit = {}) =>
      s.call(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
  }
  const create = async (agent: Awaited<ReturnType<typeof agentOf>>) =>
    (await (
      await agent("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "Survey" }),
      })
    ).json()) as { id: string; token: string };

  it("ignores a plan header a client sends", async () => {
    const s = setup();
    const agent = await agentOf(s, "ann@example.com");
    const forged = { "x-kim-plan": "pro" };
    const sessions = [];
    for (let index = 0; index < 4; index++) sessions.push(await create(agent));
    const refused = await agent(`/api/sessions/${sessions[0]!.id}/assign`, {
      method: "POST",
      headers: forged,
      body: JSON.stringify({ email: "bob@example.com" }),
    });
    expect(refused.status).toBe(402);
    expect((await refused.json()).code).toBe("plan_limit");
    // Nor does it lift the live limit: three wait, the fourth is refused.
    const hub = s.hubs.get("user:ann@example.com")!;
    for (const session of sessions.slice(0, 3))
      await agent(`/api/sessions/${session.id}/socket`, {
        headers: { ...forged, upgrade: "websocket" },
      });
    expect(hub.agents.list()).toHaveLength(3);
    const fourth = await agent(`/api/sessions/${sessions[3]!.id}/socket`, {
      headers: { ...forged, upgrade: "websocket" },
    });
    expect(fourth.status).toBe(402);
    // Without an upgrade, the same route says why, as the CLI asks it.
    const probe = await agent(`/api/sessions/${sessions[3]!.id}/socket`);
    expect(await probe.json()).toMatchObject({ code: "plan_limit" });
    // And the browser can't claim Pro either.
    const cookie = await s.signIn("ann@example.com");
    const page = await s.call(`/api/browser/${sessions[1]!.token}/assign`, {
      method: "POST",
      cookie,
      headers: { ...forged, "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com" }),
    });
    expect(page.status).toBe(402);
  });

  it("lets Pro, the owner and admins assign", async () => {
    const s = setup();
    await s.pro("pro@example.com");
    for (const email of [OWNER, "admin@example.com", "pro@example.com"]) {
      const agent = await agentOf(s, email);
      const session = await create(agent);
      const response = await agent(`/api/sessions/${session.id}/assign`, {
        method: "POST",
        body: JSON.stringify({ email: "bob@example.com" }),
      });
      expect(response.status).toBe(200);
    }
  });

  it("tells the page the plan", async () => {
    const s = setup();
    const cookie = await s.signIn(OWNER);
    const me = await (await s.call("/api/browser/me", { cookie })).json();
    expect(me.plan).toMatchObject({ plan: "pro", source: "owner" });
  });
});

describe("the Stripe webhook", () => {
  const SECRET = "whsec_test";
  /** A Worker with billing set up, and a way to send it signed events. */
  function billing() {
    const s = setup();
    Object.assign(s.env, {
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_PRICE_PRO: "price_pro",
    });
    stripeCalls.length = 0;
    stripeApi = (path) =>
      path === "/subscriptions/sub_1"
        ? Response.json(subscription({ status: "active" }))
        : Response.json({ error: { message: "Unknown" } }, { status: 404 });
    const sign = (payload: string, at = Math.floor(Date.now() / 1000)) =>
      `t=${at},v1=${createHmac("sha256", SECRET).update(`${at}.${payload}`).digest("hex")}`;
    const send = (
      event: Record<string, unknown>,
      signature?: (payload: string) => string,
    ) => {
      const payload = JSON.stringify(event);
      return s.call("/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": (signature ?? sign)(payload) },
        body: payload,
      });
    };
    const record = () =>
      JSON.parse(s.kv.data.get("plan:ann@example.com") ?? "null");
    const planOfAnn = async () => {
      plans.clear();
      const cookie = await s.signIn("ann@example.com");
      return (await (await s.call("/api/browser/me", { cookie })).json()).plan;
    };
    return { ...s, sign, send, record, planOfAnn };
  }
  /** A Pro subscription for Ann, as Stripe sends it on a recent API version. */
  const subscription = (fields: Record<string, unknown>) => ({
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    metadata: { email: "ann@example.com" },
    items: { data: [{ quantity: 1, current_period_end: 1_900_000_000 }] },
    ...fields,
  });
  const completed = {
    id: "evt_checkout",
    type: "checkout.session.completed",
    created: 1_800_000_000,
    data: {
      object: {
        object: "checkout.session",
        mode: "subscription",
        customer: "cus_1",
        subscription: "sub_1",
        client_reference_id: "ann@example.com",
        payment_status: "paid",
      },
    },
  };
  const updated = (id: string, created: number, fields = {}) => ({
    id,
    type: "customer.subscription.updated",
    created,
    data: { object: subscription(fields) },
  });

  it("refuses an event without Stripe's signature", async () => {
    const { send, sign, record } = billing();
    expect((await send(completed, () => "")).status).toBe(400);
    expect((await send(completed, () => "t=1,v1=00")).status).toBe(400);
    // Signed with another secret, or long ago.
    const other = (payload: string) => {
      const at = Math.floor(Date.now() / 1000);
      return `t=${at},v1=${createHmac("sha256", "whsec_other").update(`${at}.${payload}`).digest("hex")}`;
    };
    expect((await send(completed, other)).status).toBe(400);
    const stale = (payload: string) =>
      sign(payload, Math.floor(Date.now() / 1000) - 600);
    expect((await send(completed, stale)).status).toBe(400);
    expect(record()).toBeNull();
    // Any v1 may match, as while a rolled secret is still valid.
    const rolled = (payload: string) => `${sign(payload)},v1=${"0".repeat(64)}`;
    expect((await send(completed, rolled)).status).toBe(200);
  });

  it("puts a paid checkout on Pro, and follows the subscription after", async () => {
    const { send, record, planOfAnn, kv } = billing();
    expect((await planOfAnn()).plan).toBe("free");
    expect((await send(completed)).status).toBe(200);
    expect(stripeCalls.map((call) => call.path)).toEqual([
      "/subscriptions/sub_1",
    ]);
    expect(record()).toMatchObject({
      plan: "pro",
      status: "active",
      customerId: "cus_1",
      subscriptionId: "sub_1",
      currentPeriodEnd: 1_900_000_000_000,
      seats: 1,
    });
    expect(kv.data.get("stripe-customer:cus_1")).toBe("ann@example.com");
    expect(await planOfAnn()).toMatchObject({
      plan: "pro",
      source: "stripe",
      manageable: true,
    });
    // Cancelled in the portal: Pro until the period ends.
    await send(
      updated("evt_cancel", 1_800_000_100, { cancel_at_period_end: true }),
    );
    expect(await planOfAnn()).toMatchObject({
      plan: "pro",
      cancelAtPeriodEnd: true,
    });
    // A card that stops paying, by the customer alone (no metadata).
    await send(
      updated("evt_unpaid", 1_800_000_200, { status: "unpaid", metadata: {} }),
    );
    expect((await planOfAnn()).plan).toBe("free");
    await send(updated("evt_back", 1_800_000_300));
    expect((await planOfAnn()).plan).toBe("pro");
    await send({
      ...updated("evt_deleted", 1_800_000_400),
      type: "customer.subscription.deleted",
    });
    expect(record().status).toBe("canceled");
    expect((await planOfAnn()).plan).toBe("free");
  });

  it("applies each event once, and ignores one that arrives late", async () => {
    const { send, record } = billing();
    await send(completed);
    await send(updated("evt_unpaid", 1_800_000_200, { status: "unpaid" }));
    // Stripe delivers again: acknowledged, nothing changes.
    const again = await send(completed);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(record().status).toBe("unpaid");
    // An older event, delivered after a newer one, changes nothing either.
    await send(updated("evt_old", 1_800_000_100, { status: "active" }));
    expect(record().status).toBe("unpaid");
  });

  it("doesn't let an old subscription's end touch a newer one", async () => {
    const { send, record } = billing();
    await send(completed);
    await send({
      ...updated("evt_old_sub", 1_800_000_500, { id: "sub_0" }),
      type: "customer.subscription.deleted",
    });
    expect(record()).toMatchObject({
      subscriptionId: "sub_1",
      status: "active",
    });
  });
});

describe("upgrading", () => {
  it("says Pro is coming soon without Stripe", async () => {
    const s = setup();
    const cookie = await s.signIn("ann@example.com");
    const response = await s.call("/billing/checkout", {
      method: "POST",
      cookie,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Pro is coming soon");
    const pricing = await s.call("/pricing", { cookie });
    expect(await pricing.text()).toContain("Pro is coming soon.");
  });

  it("sends a Free user to Stripe Checkout, and a subscriber to the portal", async () => {
    const s = setup();
    Object.assign(s.env, {
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_PRICE_PRO: "price_pro",
    });
    stripeCalls.length = 0;
    stripeApi = (path) => Response.json({ url: `https://stripe.test${path}` });
    const cookie = await s.signIn("ann@example.com");
    const checkout = await s.call("/billing/checkout", {
      method: "POST",
      cookie,
    });
    expect(checkout.status).toBe(303);
    expect(checkout.headers.get("location")).toBe(
      "https://stripe.test/checkout/sessions",
    );
    expect(Object.fromEntries(stripeCalls[0]!.form)).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_pro",
      "line_items[0][quantity]": "1",
      client_reference_id: "ann@example.com",
      customer_email: "ann@example.com",
      "subscription_data[metadata][email]": "ann@example.com",
      success_url: `${ORIGIN}/pricing?checkout=done`,
    });
    // Another site can't start one.
    const forged = await s.call("/billing/checkout", {
      method: "POST",
      cookie,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(forged.status).toBe(403);
    await updatePlan(s.env, "ann@example.com", (record) => ({
      ...record,
      plan: "pro",
      status: "active",
      customerId: "cus_1",
    }));
    const portal = await s.call("/billing/portal", { method: "POST", cookie });
    expect(portal.headers.get("location")).toBe(
      "https://stripe.test/billing_portal/sessions",
    );
    expect(stripeCalls.at(-1)!.form.get("customer")).toBe("cus_1");
  });

  it("shows the plans to anyone, linked from sign-in", async () => {
    const s = setup();
    const signedOut = await s.call("/pricing");
    expect(signedOut.status).toBe(200);
    const text = await signedOut.text();
    for (const words of ["Free", "$5", "a user, a month", "Sign in to upgrade"])
      expect(text).toContain(words);
    expect(await (await s.call("/signin")).text()).toContain('href="/pricing"');
  });
});

describe("comping a plan on /admin", () => {
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

  it("shows each plan and lets an admin grant or end Pro", async () => {
    const s = setup();
    const admin = await s.signIn("admin@example.com");
    const ann = await s.signIn("ann@example.com");
    expect(await (await s.call("/admin", { cookie: admin })).text()).toMatch(
      /ann@example\.com.*<td>Free<\/td>/,
    );
    const granted = await s.call("/admin/plan", {
      ...form({ email: "ann@example.com", plan: "pro" }),
      cookie: admin,
    });
    expect(granted.status).toBe(303);
    const me = await (await s.call("/api/browser/me", { cookie: ann })).json();
    expect(me.plan).toMatchObject({ plan: "pro", source: "comp" });
    expect(await (await s.call("/admin", { cookie: admin })).text()).toContain(
      "End comp",
    );
    await s.call("/admin/plan", {
      ...form({ email: "ann@example.com", plan: "none" }),
      cookie: admin,
    });
    const after = await (
      await s.call("/api/browser/me", { cookie: ann })
    ).json();
    expect(after.plan.plan).toBe("free");
  });

  it("is not found for anyone else, and refuses another site's form", async () => {
    const s = setup();
    const ann = await s.signIn("ann@example.com");
    const admin = await s.signIn("admin@example.com");
    const fields = form({ email: "ann@example.com", plan: "pro" });
    expect(
      (await s.call("/admin/plan", { ...fields, cookie: ann })).status,
    ).toBe(404);
    const forged = await s.call("/admin/plan", {
      ...fields,
      cookie: admin,
      headers: { ...fields.headers, "sec-fetch-site": "cross-site" },
    });
    expect(forged.status).toBe(403);
    expect(s.kv.data.has("plan:ann@example.com")).toBe(false);
  });
});
