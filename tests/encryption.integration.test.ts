import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  grantFor,
  lockAccountKey,
  LOCKED,
  newAccountKey,
  newInterviewKey,
  newRecoveryCode,
  newSalt,
  open,
  openGrant,
  seal,
  toBase64Url,
  wrapTo,
  type AccountKey,
} from "../src/shared/crypto.js";
import { hubHarness } from "./helpers/harness.js";
import { serveHarness } from "./helpers/serve.js";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
  .pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const repo = new URL("..", import.meta.url).pathname;

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "kim-e2e-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs kim against a served hub, holding an account's content key (or none). */
function kimAs(address: string, account: AccountKey | null) {
  return async (...args: string[]) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      KEEP_IT_MOVING_URL: address,
      KEEP_IT_MOVING_TOKEN: "test",
      KEEP_IT_MOVING_NO_AUTO_UPDATE: "1",
      HOME: tempDir(),
      XDG_CONFIG_HOME: tempDir(),
    };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDECODE;
    delete env.KEEP_IT_MOVING_CONTENT_KEY;
    if (account) env.KEEP_IT_MOVING_CONTENT_KEY = toBase64Url(account.pkcs8);
    const { stdout } = await exec(process.execPath, [tsx, cli, ...args], {
      env,
      cwd: repo,
    });
    return JSON.parse(stdout);
  };
}

async function setUpKey(harness: ReturnType<typeof hubHarness>) {
  const account = await newAccountKey();
  const salt = newSalt();
  harness.store.setAccountKey(account.publicKey, account.fingerprint, [
    {
      id: "recovery-1",
      method: "recovery",
      salt: toBase64Url(salt),
      wrapped: await lockAccountKey(
        account,
        "recovery",
        newRecoveryCode().secret,
        salt,
      ),
    },
  ]);
  return account;
}

/** Everything the service stored about interviews, as one string. */
function stored(harness: ReturnType<typeof hubHarness>) {
  return [
    "sessions",
    "questions",
    "answers",
    "events",
    "artifacts",
    "chat_messages",
    "drafts",
  ]
    .map((table) => JSON.stringify(harness.sql.all(`SELECT * FROM ${table}`)))
    .join("\n");
}

const MOCKUP =
  '<!doctype html><html><head><style>:root{--accent:red}</style></head><body><h1 data-kim-text="headline">Pricing for Globex</h1></body></html>';

async function ownerHarness() {
  const harness = hubHarness();
  const served = await serveHarness(harness);
  cleanups.push(async () => {
    await served.close();
    setTimeout(() => harness.sql.close(), 3_000).unref();
  });
  const ann = await setUpKey(harness);
  return { harness, ann, kim: kimAs(served.address, ann), served };
}

/** An encrypted interview the CLI made, with a choice, a mockup and a bound question. */
async function encryptedInterview(kim: ReturnType<typeof kimAs>) {
  const session = await kim(
    "session",
    "create",
    "--title",
    "Acquisition of Globex",
    "--agent-session",
    "Plan the takeover",
  );
  const mockup = await kim(
    "artifact",
    "add",
    session.id,
    "--kind",
    "mockup",
    "--title",
    "Pricing page",
    "--content",
    MOCKUP,
  );
  const { questions } = await kim(
    "question",
    "add",
    session.id,
    "--json",
    JSON.stringify([
      {
        prompt: "Which price?",
        type: "single-choice",
        options: ["Ten dollars", "Twenty dollars"],
        default: "twenty DOLLARS",
        recommendation: "Cheaper wins",
      },
      {
        prompt: "Accent colour?",
        type: "single-choice",
        options: ["Crimson", "Cobalt"],
        artifactId: mockup.id,
        optionValues: {
          Crimson: { "--accent": "crimson" },
          Cobalt: { "--accent": "cobalt" },
        },
      },
    ]),
  );
  return { session, mockup, questions };
}

describe("end-to-end encryption through the CLI", () => {
  it("stores only ciphertext and gives the agent plain text", async () => {
    const { harness, kim } = await ownerHarness();
    const { session, mockup, questions } = await encryptedInterview(kim);
    expect(session.title).toBe("Acquisition of Globex");
    expect(session.kid).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(questions[0]).toMatchObject({
      prompt: "Which price?",
      options: ["Ten dollars", "Twenty dollars"],
      // Normalised to the option's spelling before it was sealed.
      default: ["Twenty dollars"],
      recommendation: "Cheaper wins",
    });
    expect(questions[1].optionValues).toEqual({
      Crimson: { "--accent": "crimson" },
      Cobalt: { "--accent": "cobalt" },
    });
    await kim("chat", "reply", session.id, "--text", "A secret reply");

    const all = stored(harness);
    for (const secret of [
      "Acquisition of Globex",
      "Plan the takeover",
      "Which price?",
      "Twenty dollars",
      "Cheaper wins",
      "Pricing page",
      "Pricing for Globex",
      "data-kim-text",
      "Crimson",
      "A secret reply",
    ])
      expect(all).not.toContain(secret);
    // The artifact's format was told, since the service can't tell it.
    expect(harness.store.getSession(session.id, "").artifacts[0]).toMatchObject(
      { id: mockup.id, format: "html" },
    );

    const shown = await kim("session", "show", session.id);
    expect(shown).toMatchObject({
      title: "Acquisition of Globex",
      origin: { agentSession: "Plan the takeover" },
      chat: [{ text: "A secret reply" }],
    });
    expect(shown.artifacts[0].title).toBe("Pricing page");
    const listed = await kim("session", "list");
    expect(listed[0].title).toBe("Acquisition of Globex");
  });

  it("checks questions as the service would, before sealing them", async () => {
    const { kim } = await ownerHarness();
    const { session, mockup } = await encryptedInterview(kim);
    const refused = kim(
      "question",
      "add",
      session.id,
      "--json",
      JSON.stringify({
        prompt: "Headline?",
        type: "single-choice",
        options: ["A"],
        artifactId: mockup.id,
        optionValues: { A: { "--missing": "x" } },
      }),
    );
    await expect(refused).rejects.toMatchObject({
      stderr: expect.stringContaining(`doesn't declare --missing`),
    });
    await expect(
      kim(
        "question",
        "add",
        session.id,
        "--prompt",
        "Pick",
        "--type",
        "single-choice",
        "--option",
        "One",
        "--default",
        "Two",
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("is not one of the options"),
    });
  });

  it("updates a question whole, and warns when an artifact drops a control", async () => {
    const { kim } = await ownerHarness();
    const { session, mockup, questions } = await encryptedInterview(kim);
    const updated = await kim(
      "question",
      "update",
      session.id,
      questions[0].id,
      "--json",
      JSON.stringify({
        options: ["Ten dollars", "Thirty dollars"],
        default: "Thirty dollars",
      }),
    );
    // What it didn't change stays as it was.
    expect(updated).toMatchObject({
      prompt: "Which price?",
      recommendation: "Cheaper wins",
      options: ["Ten dollars", "Thirty dollars"],
      default: ["Thirty dollars"],
    });
    const revised = await kim(
      "artifact",
      "update",
      session.id,
      mockup.id,
      "--content",
      "<!doctype html><html><body>plain</body></html>",
    );
    expect(revised.warnings).toEqual([
      expect.stringContaining(
        `artifact "Pricing page" doesn't declare --accent`,
      ),
    ]);
  });

  it("brings the browser's sealed answers to the agent, finishing the batch", async () => {
    const { harness, ann, kim } = await ownerHarness();
    const { session, questions } = await encryptedInterview(kim);
    // The browser: open the grant, seal the answers, send them.
    const grant = (
      await harness.app.inject({
        method: "GET",
        url: `/api/browser/${session.token}/grant?fp=${ann.fingerprint}`,
      })
    ).json();
    const key = await openGrant(ann, grant.kid, grant.wrapped);
    for (const [question, answer] of [
      [questions[0], "Twenty dollars"],
      [questions[1], "Cobalt"],
    ] as const) {
      const sent = await harness.app.inject({
        method: "POST",
        url: `/api/browser/${session.token}/questions/${question.id}/answer`,
        payload: { answer: await seal(key, answer) },
      });
      expect(sent.statusCode).toBe(200);
    }
    // A plain answer can't get into an encrypted interview.
    const plain = await harness.app.inject({
      method: "POST",
      url: `/api/browser/${session.token}/chat`,
      payload: { text: "in the clear" },
    });
    expect(plain.statusCode).toBe(400);
    expect(plain.json().error).toMatch(/must be encrypted/);

    const batch = await kim(
      "wait",
      session.id,
      "--idle",
      "0",
      "--timeout",
      "5000",
    );
    expect(batch.answers).toEqual([
      expect.objectContaining({
        prompt: "Which price?",
        answer: "Twenty dollars",
        acceptedDefault: true,
      }),
      expect.objectContaining({
        prompt: "Accent colour?",
        answer: "Cobalt",
        acceptedDefault: false,
        applied: {
          artifactId: questions[1].artifactId,
          values: { "--accent": "cobalt" },
        },
      }),
    ]);
    expect(batch.answers[0]).not.toHaveProperty("question");
    expect(stored(harness)).not.toContain("Cobalt");
  });

  it("refuses to make an interview without the account's key", async () => {
    const { served } = await ownerHarness();
    await expect(
      kimAs(served.address, null)("session", "create", "--title", "Nope"),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("doesn't have your key"),
    });
  });

  it("leaves interviews plain for an account without encryption", async () => {
    const harness = hubHarness();
    const served = await serveHarness(harness);
    cleanups.push(async () => {
      await served.close();
      setTimeout(() => harness.sql.close(), 3_000).unref();
    });
    const session = await kimAs(served.address, null)(
      "session",
      "create",
      "--title",
      "Out in the open",
    );
    expect(session.kid).toBeNull();
    expect(stored(harness)).toContain("Out in the open");
  });
});

describe("an encrypted interview sent to someone", () => {
  /** Ann's encrypted interview, assigned to Bob, whose CLI reaches it by its inbox. */
  async function sentToBob() {
    const { harness, ann, kim, served } = await ownerHarness();
    const made = await encryptedInterview(kim);
    const bob = await newAccountKey();
    const grant = harness.store.grants(made.session.id)[0]!;
    const key = await openGrant(ann, made.session.kid, grant.wrapped);
    harness.store.assignSession(made.session.id, "bob@example.com", "Ann");
    harness.store.addGrants(made.session.id, [
      {
        fp: bob.fingerprint,
        role: "assignee",
        wrapped: await grantFor(bob.publicKey, key),
      },
    ]);
    // Bob's requests, as the Worker routes them: inbox paths reach Ann's
    // hub as the assignee; his own hub has no grants for this.
    const bobs = await serveHarness(harness, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/sessions/kim/grants")
        return Response.json({ grants: [] });
      const inbox = /^\/api\/sessions\/inbox\/(.+)$/.exec(url.pathname);
      if (!inbox) return harness.app.fetch(request);
      const forwarded = new Request(
        new URL(`/api/inbox/${inbox[1]}${url.search}`, url),
        request,
      );
      forwarded.headers.set("x-kim-respondent", "bob@example.com");
      forwarded.headers.set("x-kim-drafter", "bob@example.com");
      return harness.app.fetch(forwarded);
    });
    cleanups.push(() => bobs.close());
    void served;
    return { ...made, harness, key, owner: kim, bob: kimAs(bobs.address, bob) };
  }

  it("opens for the assignee's agent, renders, and takes its sealed answers", async () => {
    const { harness, session, mockup, key, owner, bob } = await sentToBob();
    const view = await bob("inbox", "show", session.token);
    expect(view).toMatchObject({
      title: "Acquisition of Globex",
      questions: [
        { prompt: "Which price?", default: ["Twenty dollars"] },
        { prompt: "Accent colour?", options: ["Crimson", "Cobalt"] },
      ],
    });

    const sent = await bob(
      "draft",
      session.token,
      "2",
      "--option",
      "cobalt",
      "--send",
    );
    expect(sent).toMatchObject({
      answer: { text: "Cobalt", skipped: false },
      question: { prompt: "Accent colour?" },
    });
    expect(stored(harness)).not.toContain("Cobalt");
    // The owner reads the assignee's answer in plain text.
    const shown = await owner("session", "show", session.id);
    expect(shown.questions[1].answer).toMatchObject({
      text: "Cobalt",
      answeredBy: "bob@example.com",
    });

    const file = join(tempDir(), "mockup.html");
    await bob("inbox", "artifact", session.token, mockup.id, "--out", file);
    const page = readFileSync(file, "utf8");
    expect(page).toContain("Pricing for Globex");
    expect(page).toContain('"--accent":"cobalt"');

    await bob("inbox", "chat", session.token, "A question back");
    const message = harness.store.getSession(session.id, "").chat.at(-1)!;
    expect(message.text).not.toContain("A question back");
    expect(await open(key, message.text)).toBe("A question back");
  });
});

describe("the hub's encryption routes", () => {
  it("sets up a key once, and keeps it to the account", async () => {
    const harness = hubHarness();
    cleanups.push(() => harness.sql.close());
    const account = await newAccountKey();
    const salt = newSalt();
    const unlock = {
      id: "recovery-1",
      method: "recovery",
      salt: toBase64Url(salt),
      wrapped: await lockAccountKey(
        account,
        "recovery",
        newRecoveryCode().secret,
        salt,
      ),
    };
    const first = await harness.app.inject({
      method: "POST",
      url: "/api/browser/account/key",
      payload: { publicKey: account.publicKey, unlocks: [unlock] },
    });
    expect(first.json()).toMatchObject({ fingerprint: account.fingerprint });
    const again = await harness.app.inject({
      method: "POST",
      url: "/api/browser/account/key",
      payload: { publicKey: account.publicKey, unlocks: [unlock] },
    });
    expect(again.statusCode).toBe(400);
    expect(
      (
        await harness.app.inject({
          method: "GET",
          url: "/api/sessions/kim/account",
        })
      ).json(),
    ).toEqual({
      publicKey: account.publicKey,
      fingerprint: account.fingerprint,
    });
    const removeLast = await harness.app.inject({
      method: "DELETE",
      url: "/api/browser/account/unlocks/recovery-1",
    });
    expect(removeLast.json().error).toMatch(/only way left/);
  });

  it("frames an encrypted mockup in the page, not at its own URL", async () => {
    const { harness, kim } = await ownerHarness();
    const { session, mockup } = await encryptedInterview(kim);
    const view = await harness.app.inject({
      method: "GET",
      url: `/api/browser/${session.token}/artifacts/${mockup.id}/view`,
    });
    expect(view.statusCode).toBe(400);
    const content = await harness.app.inject({
      method: "GET",
      url: `/api/browser/${session.token}/artifacts/${mockup.id}/content`,
    });
    expect(content.json()).toMatchObject({
      format: "html",
      content: expect.stringMatching(/^kim1\./),
    });
  });

  it("lets a cloud environment's key read grants, and nothing else under kim/", async () => {
    const { keyMayCall } = await import("../src/server/hub.js");
    expect(keyMayCall("GET", "/api/sessions/kim/grants")).toBe(true);
    expect(keyMayCall("GET", "/api/sessions/kim/account")).toBe(true);
    expect(keyMayCall("GET", "/api/sessions/kim/keys")).toBe(false);
    expect(keyMayCall("POST", "/api/sessions/kim/grants")).toBe(false);
    expect(keyMayCall("GET", "/api/sessions/abc/grant")).toBe(true);
    expect(keyMayCall("POST", "/api/sessions/abc/grants")).toBe(false);
  });
});

describe("what a writer without the key can't do", () => {
  it("can't hand over a different key under an interview's id", async () => {
    const real = await newInterviewKey();
    const fake = await newInterviewKey();
    const victim = await newAccountKey();
    const forged = await wrapTo(victim.publicKey, fake.raw);
    await expect(openGrant(victim, real.kid, forged)).rejects.toThrow(
      /isn't this interview's/,
    );
  });

  it("can't replace a grant, and can't make a plain interview for an encrypted account", async () => {
    const { harness, ann, kim } = await ownerHarness();
    const { session } = await encryptedInterview(kim);
    const before = harness.store.grants(session.id);
    harness.store.addGrants(session.id, [
      {
        fp: ann.fingerprint,
        role: "owner",
        wrapped: await wrapTo(ann.publicKey, (await newInterviewKey()).raw),
      },
    ]);
    expect(harness.store.grants(session.id)).toEqual(before);
    const plain = await harness.app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Sneaky" },
    });
    expect(plain.statusCode).toBe(400);
    expect(plain.json().error).toMatch(/kim update/);
  });

  it("won't seal a field that couldn't be opened", async () => {
    const key = await newInterviewKey();
    await expect(seal(key, `${LOCKED}`)).rejects.toThrow(/still encrypted/);
  });
});
