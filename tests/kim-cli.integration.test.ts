import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
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
/** A PNG's signature and a little more: the CLI saves the bytes as they come. */
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "interviewer-kim-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listeningHarness() {
  const harness = hubHarness();
  /** Every request's method and path, in order. */
  const requests: string[] = [];
  const served = await serveHarness(harness, (request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return harness.app.fetch(request);
  });
  cleanups.push(async () => {
    await served.close();
    // The hub checks for push a couple of seconds after questions arrive;
    // later tests keep the process alive, so close the database after that.
    setTimeout(() => harness.sql.close(), 3_000).unref();
  });
  return { ...harness, requests, address: served.address };
}

const env = (address: string, extra: Record<string, string> = {}) => {
  const base = { ...process.env };
  delete base.CLAUDE_CODE_SESSION_ID;
  delete base.CLAUDE_CODE_REMOTE;
  delete base.CLAUDE_CODE_REMOTE_SESSION_ID;
  return {
    ...base,
    KEEP_IT_MOVING_URL: address,
    KEEP_IT_MOVING_TOKEN: "test",
    ...extra,
  };
};

/** Runs the CLI against the harness, from this repo. */
const kim = (address: string, ...args: string[]) =>
  exec(process.execPath, [tsx, cli, ...args], { env: env(address), cwd: repo });

describe("ask", () => {
  it("creates an interview with its questions, then waits like wait", async () => {
    const { address, store } = await listeningHarness();
    const { stdout, stderr } = await kim(
      address,
      "ask",
      "--title",
      "Run the migration?",
      "--prompt",
      "Back up first?",
      "--type",
      "yes-no",
      "--timeout",
      "500",
    );
    const result = JSON.parse(stdout);
    expect(stderr).toContain(result.url);
    expect(result).toMatchObject({
      events: expect.any(Array),
      openQuestions: 1,
    });
    const session = store.getSession(result.interviewId, "");
    expect(session.title).toBe("Run the migration?");
    expect(session.questions[0]!.prompt).toBe("Back up first?");
  });
});

describe("wait over the socket", () => {
  it("returns the batch once answered, never using the HTTP long-polls", async () => {
    const { address, store, requests } = await listeningHarness();
    const session = store.createSession("", { title: "Socket" });
    const [question] = store.addQuestions(session.id, [
      { type: "text", prompt: "Name?" },
    ]);
    const waiting = kim(address, "wait", session.id, "--idle", "0");
    while (!requests.some((line) => line.endsWith("/socket")))
      await new Promise((resolve) => setTimeout(resolve, 50));
    store.answerQuestion(session.id, question!.id, { answer: "Kim" });
    const batch = JSON.parse((await waiting).stdout);
    expect(batch.answers).toEqual([
      expect.objectContaining({ answer: "Kim", number: 1 }),
    ]);
    expect(
      requests.filter((line) => /\/(wait|attach|events\/next)$/.test(line)),
    ).toEqual([]);
    expect(store.undeliveredEvents(session.id)).toEqual([]);
  });

  it("exits with an error for an interview that isn't there", async () => {
    const { address } = await listeningHarness();
    await expect(kim(address, "wait", "missing")).rejects.toMatchObject({
      stderr: expect.stringContaining("Session not found"),
    });
  });
});

describe("question add with controls", () => {
  it("binds options with --set and a number with --bind and --unit", async () => {
    const { address, store } = await listeningHarness();
    const session = store.createSession("", { title: "Look" });
    const mockup = store.addArtifact(session.id, {
      kind: "mockup",
      title: "Home",
      content:
        "<html><style>:root{--font-display:Inter;--radius:8px}</style></html>",
    });
    const add = async (...args: string[]) =>
      JSON.parse(
        (await kim(address, "question", "add", session.id, ...args)).stdout,
      ).questions[0];
    const font = await add(
      "--prompt",
      "Display font?",
      "--type",
      "single-choice",
      "--artifact",
      mockup.id,
      "--option",
      "Inter",
      "--option",
      "Space = Grotesk",
      "--set",
      "Inter=--font-display=Inter",
      "--set",
      'Space = Grotesk=--font-display="Space Grotesk", sans-serif',
    );
    expect(font.optionValues).toEqual({
      Inter: { "--font-display": "Inter" },
      "Space = Grotesk": { "--font-display": '"Space Grotesk", sans-serif' },
    });
    const radius = await add(
      "--prompt",
      "Corner radius?",
      "--type",
      "number",
      "--artifact",
      mockup.id,
      "--bind",
      "--radius",
      "--unit",
      "px",
      "--min",
      "0",
      "--max",
      "24",
    );
    expect(radius).toMatchObject({ control: "--radius", unit: "px", max: 24 });

    const bad = await kim(
      address,
      "question",
      "add",
      session.id,
      "--prompt",
      "Font?",
      "--set",
      "Inter:--font-display",
    ).catch((error: { stderr: string }) => error);
    expect(JSON.parse(bad.stderr).error).toContain(
      "--set takes <option>=<control>=<value>",
    );
  }, 30_000);
});

describe("session delete", () => {
  it("deletes several interviews by id and prints what went", async () => {
    const { address, store } = await listeningHarness();
    const a = store.createSession("", { title: "A" });
    const b = store.createSession("", { title: "B" });
    const kept = store.createSession("", { title: "Kept" });
    const { stdout } = await kim(address, "session", "delete", a.id, b.id);
    expect(JSON.parse(stdout)).toEqual({
      deleted: [
        { id: a.id, title: "A", assignee: null },
        { id: b.id, title: "B", assignee: null },
      ],
    });
    expect(store.listSessions("", true).map((session) => session.id)).toEqual([
      kept.id,
    ]);
  });

  it("deletes every stopped interview with --stopped", async () => {
    const { address, store } = await listeningHarness();
    const done = store.createSession("", { title: "Done" });
    store.setSessionStatus(done.id, "stopped");
    const shared = store.createSession("", { title: "Shared" });
    store.assignSession(shared.id, "bob@example.com", "Ann");
    store.setSessionStatus(shared.id, "stopped");
    const active = store.createSession("", { title: "Active" });
    const { stdout } = await kim(address, "session", "delete", "--stopped");
    const { deleted } = JSON.parse(stdout) as {
      deleted: Array<{ id: string; title: string; assignee: string | null }>;
    };
    expect(deleted).toHaveLength(2);
    expect(deleted).toEqual(
      expect.arrayContaining([
        { id: done.id, title: "Done", assignee: null },
        { id: shared.id, title: "Shared", assignee: "bob@example.com" },
      ]),
    );
    expect(store.listSessions("", true).map((session) => session.id)).toEqual([
      active.id,
    ]);
    // Nothing left to delete is not an error.
    expect(
      JSON.parse((await kim(address, "session", "delete", "--stopped")).stdout),
    ).toEqual({ deleted: [] });
  });

  it("keeps going past an id that fails, and exits 1", async () => {
    const { address, store } = await listeningHarness();
    const a = store.createSession("", { title: "A" });
    const failure = (await kim(
      address,
      "session",
      "delete",
      "missing",
      a.id,
    ).catch((error: unknown) => error)) as { code: number; stdout: string };
    expect(failure.code).toBe(1);
    expect(JSON.parse(failure.stdout)).toEqual({
      deleted: [{ id: a.id, title: "A", assignee: null }],
      failed: [{ id: "missing", error: "Session not found" }],
    });
  });
});

describe("cloud setup", () => {
  it("creates the project's key and prints its environment, ready to paste", async () => {
    const { address, app } = await listeningHarness();
    const run = (...args: string[]) =>
      exec(
        process.execPath,
        [
          tsx,
          cli,
          "cloud",
          "setup",
          "--project",
          "github.com/o/frockbot",
          ...args,
        ],
        { env: env(address), cwd: repo },
      );
    const { stdout } = await run();
    const host = new URL(address).host;
    const key = stdout.match(/^KEEP_IT_MOVING_TOKEN=(kim_\S+)$/m)?.[1];
    expect(key).toBeTruthy();
    expect(stdout).toContain(
      "Cloud environment for Frockbot (github.com/o/frockbot)",
    );
    expect(stdout).toContain("Level: Custom");
    expect(stdout).toContain(`Allowed domains: ${host}`);
    expect(stdout).toContain(`KEEP_IT_MOVING_URL=${address}`);
    expect(stdout).toContain(
      `-o /tmp/kim-cli.tgz ${address}/api/sessions/kim/cli.tgz && npm install -g /tmp/kim-cli.tgz || true`,
    );
    expect(stdout).toContain(
      '"Authorization: Bearer ${KEEP_IT_MOVING_TOKEN:-$INTERVIEWER_TOKEN}"',
    );
    expect(stdout).not.toContain("hooks");
    expect(stdout).toContain("kim key revoke 'Frockbot cloud'");
    if (process.env.SHOW_CLOUD_SETUP) process.stderr.write(stdout);

    const keys = (
      await app.inject({ method: "GET", url: "/api/sessions/kim/keys" })
    ).json().keys;
    expect(keys).toMatchObject([{ name: "Frockbot cloud", revokedAt: null }]);

    // An existing key is never shown again.
    const repeated = (await run().catch((error: unknown) => error)) as {
      stdout: string;
      stderr: string;
    };
    expect(repeated.stderr).toContain(
      'A live key is already named \\"Frockbot cloud\\"',
    );
    expect(repeated.stdout).toBe("");

    const json = JSON.parse(
      (await run("--key-name", "Frockbot cloud 2", "--json")).stdout,
    );
    expect(json).toMatchObject({
      project: { key: "github.com/o/frockbot", name: "Frockbot" },
      keyName: "Frockbot cloud 2",
      network: { level: "Custom", allow: [host], keepDefaultPackages: true },
    });
    expect(json.environment).toMatch(/^KEEP_IT_MOVING_TOKEN=kim_/);
    expect(json.setupScript).toContain("|| true");
  });
});

describe("the CLI package", () => {
  it("packs dist/cli.js with its bins and only its runtime dependencies", async () => {
    const dir = tempDir();
    const tarball = join(dir, "cli.tgz");
    await exec("npm", ["run", "build:cli"], { cwd: repo });
    await exec(process.execPath, [
      join(repo, "scripts", "pack-cli.mjs"),
      "--out",
      tarball,
    ]);
    const files = (await exec("tar", ["-tzf", tarball])).stdout
      .trim()
      .split("\n")
      .sort();
    expect(files).toEqual([
      "package/LICENSE",
      "package/README.md",
      "package/build.json",
      "package/dist/checkbox.js",
      "package/dist/cli.js",
      "package/dist/hook.js",
      "package/dist/hooks.js",
      "package/dist/inlineImages.js",
      "package/dist/shared/answers.js",
      "package/dist/shared/remote.js",
      "package/dist/skill.js",
      "package/dist/update.js",
      "package/package.json",
      "package/skills/interviewer/SKILL.md",
    ]);
    const manifest = JSON.parse(
      (await exec("tar", ["-xzOf", tarball, "package/package.json"])).stdout,
    );
    expect(manifest.bin).toEqual({
      interviewer: "dist/cli.js",
      kim: "dist/cli.js",
    });
    expect(manifest.type).toBe("module");
    expect(Object.keys(manifest.dependencies)).toEqual(["env-paths"]);
    // The build stamp kim compares with the site's cli-version.json.
    const stamp = JSON.parse(
      (await exec("tar", ["-xzOf", tarball, "package/build.json"])).stdout,
    );
    expect(stamp).toEqual({
      version: manifest.version,
      build: expect.stringMatching(/^[0-9a-f]{12}$/) as string,
    });
    expect(
      JSON.parse(readFileSync(join(dir, "cli-version.json"), "utf8")),
    ).toEqual(stamp);
  }, 60_000);
});

describe("settings from before the rename", () => {
  it("still reads INTERVIEWER_URL and INTERVIEWER_TOKEN", async () => {
    const { address, requests } = await listeningHarness();
    const base = env(address);
    delete (base as Record<string, unknown>).KEEP_IT_MOVING_URL;
    delete (base as Record<string, unknown>).KEEP_IT_MOVING_TOKEN;
    const { stdout } = await exec(
      process.execPath,
      [tsx, cli, "session", "list"],
      { env: { ...base, INTERVIEWER_URL: address, INTERVIEWER_TOKEN: "test" } },
    );
    expect(JSON.parse(stdout)).toEqual([]);
    expect(requests).toContain("GET /api/sessions");
  });
});

describe("the inbox, as the assignee's agent", () => {
  /**
   * Ann's assigned interview behind a stand-in for the Worker: inbox routes
   * reach the hub as Bob, as the Worker's inbox.ts sends them.
   */
  async function inboxHarness() {
    const harness = hubHarness();
    const { store } = harness;
    const session = store.createSession("", { title: "Venue survey" });
    const mockup = store.addArtifact(session.id, {
      kind: "mockup",
      title: "Layout A",
      description: "Phone layout",
      content:
        '<!doctype html><html><head></head><body><h1 data-kim-text="headline">Hello</h1></body></html>',
    });
    store.addArtifact(session.id, {
      kind: "plan",
      title: "Plan",
      content: "# The plan",
    });
    const questions = store.addQuestions(session.id, [
      {
        prompt: "Which room?",
        type: "single-choice",
        options: ["Big", "Small"],
      },
      {
        prompt: "Headline?",
        artifactId: mockup.id,
        control: "#headline",
      },
    ]);
    store.assignSession(session.id, "bob@example.com", "Ann");
    /** The Worker renders screenshots; this stands in for its reply. */
    const screenshots: string[] = [];
    let screenshot = () =>
      new Response(PNG, {
        headers: {
          "content-type": "image/png",
          "x-kim-width": "390",
          "x-kim-height": "844",
          "x-kim-revision": "1",
          "x-kim-cache": "miss",
        },
      });
    const served = await serveHarness(harness, (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/screenshot")) {
        screenshots.push(`${url.pathname}${url.search}`);
        return screenshot();
      }
      const inbox = /^\/api\/sessions\/inbox\/(.+)$/.exec(url.pathname);
      if (!inbox) return harness.app.fetch(request);
      // A wait's socket is in the user's own hub, which this one stands in for.
      if (inbox[1] === "socket")
        return harness.app.fetch(
          new Request(new URL("/internal/inbox/socket", url), request),
        );
      const forwarded = new Request(
        new URL(`/api/inbox/${inbox[1]}${url.search}`, url),
        request,
      );
      forwarded.headers.set("x-kim-respondent", "bob@example.com");
      forwarded.headers.set("x-kim-drafter", "bob@example.com");
      return harness.app.fetch(forwarded);
    });
    cleanups.push(async () => {
      await served.close();
      setTimeout(() => harness.sql.close(), 3_000).unref();
    });
    const run = (...args: string[]) =>
      kim(served.address, ...args).then(({ stdout }) => JSON.parse(stdout));
    return {
      ...harness,
      session,
      mockup,
      questions,
      run,
      screenshots,
      screenshotReply: (reply: () => Response) => {
        screenshot = reply;
      },
      ...served,
    };
  }

  it("shows the interview with commands for what isn't inline", async () => {
    const { run, session, mockup } = await inboxHarness();
    const view = await run(
      "inbox",
      "show",
      `https://kim.test/s/${session.token}`,
    );
    expect(view).toMatchObject({ id: session.token, from: "Ann" });
    const html = view.artifacts.find((a: { id: string }) => a.id === mockup.id);
    expect(html).toMatchObject({
      frame: { width: 390, height: 844 },
      revision: 1,
      fetch: `kim inbox artifact ${session.token} ${mockup.id} --out <file>`,
      screenshot: `kim inbox screenshot ${session.token} ${mockup.id}`,
    });
    expect(
      view.artifacts.find((a: { kind: string }) => a.kind === "plan").content,
    ).toBe("# The plan");
  });

  it("drafts, sends, clears and chats, printing what it did", async () => {
    const { run, store, session, questions } = await inboxHarness();
    expect(
      await run(
        "draft",
        session.token,
        "1",
        "--option",
        "small",
        "--note",
        "quieter",
      ),
    ).toMatchObject({
      question: { id: questions[0]!.id, number: 1, prompt: "Which room?" },
      draft: { text: "Small — quieter", skipped: false },
      url: expect.stringContaining(session.token),
    });
    expect(await run("draft", session.token, "1", "--clear")).toMatchObject({
      cleared: true,
    });
    expect(
      await run(
        "draft",
        session.token,
        "2",
        "Welcome",
        "to",
        "the",
        "venue",
        "--send",
      ),
    ).toMatchObject({
      sent: true,
      answer: { text: "Welcome to the venue", skipped: false, revision: 1 },
    });
    expect(store.getSession(session.id, "").questions[1]!.answer).toMatchObject(
      { text: "Welcome to the venue", answeredBy: "bob@example.com" },
    );
    expect(
      await run(
        "inbox",
        "chat",
        session.token,
        "--question",
        "1",
        "Does",
        "Big",
        "have",
        "parking?",
      ),
    ).toMatchObject({
      message: {
        text: "Does Big have parking?",
        question: { id: questions[0]!.id, number: 1 },
      },
    });
    await expect(
      kim(
        // Through the same stand-in, an answer the form wouldn't take.
        (await inboxHarness()).address,
        "draft",
        session.token,
        "1",
        "Huge",
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("error") });
  });

  it("saves an artifact as served, with answers applied", async () => {
    const { run, store, session, mockup, questions } = await inboxHarness();
    store.answerQuestion(session.id, questions[1]!.id, { answer: "Welcome" });
    const file = join(tempDir(), "layout.html");
    const saved = await run(
      "inbox",
      "artifact",
      session.token,
      mockup.id,
      "--out",
      file,
    );
    expect(saved).toMatchObject({ id: mockup.id, revision: 1, file });
    expect(saved.content).toBeUndefined();
    expect(readFileSync(file, "utf8")).toContain(">Welcome</h1>");
  });

  it("saves the screenshot the service renders, and relays a refusal", async () => {
    const { run, session, mockup, screenshots, screenshotReply, address } =
      await inboxHarness();
    const file = join(tempDir(), "phone.png");
    const shot = await run(
      "inbox",
      "screenshot",
      session.token,
      mockup.id,
      "--width",
      "390",
      "--full-page",
      "--out",
      file,
    );
    expect(shot).toEqual({
      file,
      width: 390,
      height: 844,
      revision: 1,
      cached: false,
    });
    expect(readFileSync(file)).toEqual(Buffer.from(PNG));
    expect(screenshots).toEqual([
      `/api/sessions/inbox/${session.token}/artifacts/${mockup.id}/screenshot?width=390&fullPage=1`,
    ]);
    screenshotReply(() =>
      Response.json(
        {
          error: "Screenshots of artifacts are a Pro feature.",
          code: "plan_limit",
          feature: "screenshot",
          upgradeUrl: "https://kim.test/pricing",
        },
        { status: 402 },
      ),
    );
    await expect(
      kim(address, "inbox", "screenshot", session.token, mockup.id),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/Pro feature[\s\S]*\/pricing/),
    });
  });

  it("gives an artifact as written with the values to apply, and peeks without delivering", async () => {
    const { run, store, session, mockup, questions, address } =
      await inboxHarness();
    store.answerQuestion(session.id, questions[1]!.id, { answer: "Welcome" });
    const raw = await run(
      "inbox",
      "artifact",
      session.token,
      mockup.id,
      "--raw",
    );
    expect(raw.content).toContain(">Hello</h1>");
    expect(raw.content).not.toContain("<script>");
    expect(raw.values).toEqual({ "#headline": "Welcome" });
    // A peek leaves the news for the agent's wait.
    await run("inbox", "show", session.token, "--peek");
    const news = JSON.parse(
      (await kim(address, "inbox", "wait", session.token, "--timeout", "5000"))
        .stdout,
    );
    expect(news.interviews).toEqual([
      expect.objectContaining({ id: session.token }),
    ]);
  }, 15_000);

  it("waits over a socket for what's new, delivering it once", async () => {
    const { store, session, mockup, address } = await inboxHarness();
    // The first look at a newly sent interview is news at once.
    const first = JSON.parse(
      (await kim(address, "inbox", "wait", session.token, "--timeout", "5000"))
        .stdout,
    );
    expect(first.interviews).toEqual([
      expect.objectContaining({ id: session.token, assigned: true }),
    ]);
    const waiting = kim(
      address,
      "inbox",
      "wait",
      session.token,
      "--idle",
      "200",
      "--timeout",
      "10000",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    store.addQuestions(session.id, [{ prompt: "Budget?" }]);
    store.updateArtifact(session.id, mockup.id, { description: "Phone, v2" });
    store.updateArtifact(session.id, mockup.id, { description: "Phone, v3" });
    const news = JSON.parse((await waiting).stdout);
    expect(news.interviews).toEqual([
      expect.objectContaining({
        questions: [expect.objectContaining({ prompt: "Budget?" })],
        artifacts: [
          expect.objectContaining({
            id: mockup.id,
            happened: ["revised"],
            revision: 3,
          }),
        ],
      }),
    ]);
    // Nothing new since: it times out empty.
    expect(
      JSON.parse(
        (
          await kim(
            address,
            "inbox",
            "wait",
            session.token,
            "--timeout",
            "1500",
          )
        ).stdout,
      ),
    ).toEqual({ interviews: [], timedOut: true });
  }, 20_000);
});

describe("overview, answer and artifact get, for tools such as the Orca plugin", () => {
  async function ownerHarness() {
    const harness = hubHarness();
    const { store } = harness;
    const session = store.createSession("http://kim.test", {
      title: "CRM data model",
      origin: { branch: "crm", worktree: "crm-person-model" },
    });
    const mockup = store.addArtifact(session.id, {
      kind: "mockup",
      title: "Person page",
      content:
        '<!doctype html><html><body data-kim-layout="side"><img src="IMAGE"><div style="background:url(\'IMAGE\')">x</div><img src="https://fonts.gstatic.com/x.woff2"></body></html>',
    });
    const questions = store.addQuestions(session.id, [
      {
        prompt: "Which fields?",
        type: "multiple-choice",
        options: ["Email", "Phone", "Title"],
      },
      {
        prompt: "Layout?",
        type: "single-choice",
        options: ["Side", "Tabs"],
        artifactId: mockup.id,
        optionValues: {
          Side: { "@layout": "side" },
          Tabs: { "@layout": "tabs" },
        },
      },
    ]);
    const served = await serveHarness(harness, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/image.png")
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      if (url.pathname === "/api/sessions/inbox")
        return Response.json({ interviews: [] });
      return harness.app.fetch(request);
    });
    // The mockup's image is on this server.
    store.updateArtifact(session.id, mockup.id, {
      content: store
        .artifactContent(session.id, mockup.id)
        .content.replaceAll("IMAGE", `${served.address}/image.png`),
    });
    cleanups.push(async () => {
      await served.close();
      setTimeout(() => harness.sql.close(), 3_000).unref();
    });
    const run = (...args: string[]) =>
      kim(served.address, ...args).then(({ stdout }) => JSON.parse(stdout));
    return {
      ...harness,
      session,
      mockup,
      questions,
      run,
      address: served.address,
    };
  }

  it("lists every interview with its url, what waits on the user and the inbox", async () => {
    const { run, session } = await ownerHarness();
    const overview = await run("overview");
    expect(overview.inbox).toEqual([]);
    expect(overview.sessions).toEqual([
      expect.objectContaining({
        id: session.id,
        title: "CRM data model",
        url: expect.stringMatching(new RegExp(`/s/${session.token}$`)),
        open: 2,
        agentWatching: false,
        origin: expect.objectContaining({
          branch: "crm",
          worktree: "crm-person-model",
        }),
      }),
    ]);
  });

  it("answers a question by number as the browser form would", async () => {
    const { run, store, session } = await ownerHarness();
    await run(
      "answer",
      session.id,
      "1",
      "--option",
      "Email",
      "--option",
      "Title",
      "--note",
      "for now",
    );
    const answered = store.getSession(session.id, "").questions[0]!.answer;
    expect(answered?.text).toBe("Email, Title — for now");
    await expect(
      kim(
        (await ownerHarness()).address,
        "answer",
        session.id,
        "1",
        "--option",
        "Fax",
      ),
    ).rejects.toThrow();
  });

  it("gets an artifact with its values, embedding web images but not fonts", async () => {
    const { run, store, session, mockup, questions, address } =
      await ownerHarness();
    store.answerQuestion(session.id, questions[1]!.id, { answer: "Tabs" });
    const got = await run(
      "artifact",
      "get",
      session.id,
      mockup.id,
      "--inline-images",
    );
    expect(got.values).toEqual({ "@layout": "tabs" });
    expect(got.images).toEqual({ embedded: 1, skipped: [] });
    expect(got.content).not.toContain(`${address}/image.png`);
    expect(got.content.match(/data:image\/png;base64,/g)).toHaveLength(2);
    expect(got.content).toContain("https://fonts.gstatic.com/x.woff2");
  });

  it("prints the overview again only when it changes, with --watch", async () => {
    const { store, session, address } = await ownerHarness();
    const child = (await import("node:child_process")).spawn(
      process.execPath,
      [tsx, cli, "overview", "--watch", "--interval", "2000"],
      { env: env(address), cwd: repo },
    );
    cleanups.push(() => void child.kill());
    const lines: Array<{ sessions: Array<{ open: number }> }> = [];
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop()!;
      for (const part of parts) if (part.trim()) lines.push(JSON.parse(part));
    });
    await vi.waitFor(() => expect(lines).toHaveLength(1), { timeout: 8000 });
    store.addQuestions(session.id, [{ prompt: "Budget?" }]);
    await vi.waitFor(() => expect(lines).toHaveLength(2), { timeout: 8000 });
    expect(lines[1]!.sessions[0]!.open).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(lines).toHaveLength(2);
  }, 25_000);
});
