import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { findBrowser } from "../src/render.js";
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

async function listeningHarness(files?: (request: Request) => Response | null) {
  const harness = hubHarness();
  /** Every request's method and path, in order. */
  const requests: string[] = [];
  const served = await serveHarness(harness, (request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return files?.(request) ?? harness.app.fetch(request);
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
/** The same, with more environment. */
const kimWith = (
  address: string,
  extra: Record<string, string>,
  ...args: string[]
) =>
  exec(process.execPath, [tsx, cli, ...args], {
    env: env(address, extra),
    cwd: repo,
  });

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
      "package/dist/designFiles.js",
      "package/dist/designSync.js",
      "package/dist/hook.js",
      "package/dist/hooks.js",
      "package/dist/render.js",
      "package/dist/shared/designs.js",
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
    const served = await serveHarness(harness, (request) => {
      const url = new URL(request.url);
      const inbox = /^\/api\/sessions\/inbox\/(.+)$/.exec(url.pathname);
      if (!inbox) return harness.app.fetch(request);
      // A wait's socket is in the user's own hub, which this one stands in for.
      if (inbox[1] === "socket")
        return harness.app.fetch(
          new Request(new URL("/internal/inbox/socket", url), request),
        );
      const forwarded = new Request(
        new URL(`/api/inbox/${inbox[1]}`, url),
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

  it("renders the screenshot in a browser on this machine", async (context) => {
    let browser: string;
    try {
      browser = findBrowser();
    } catch {
      return context.skip("no Chrome, Edge or Chromium on this machine");
    }
    const { session, mockup, questions, address } = await inboxHarness();
    // The page as its frame serves it: the saved answer's text is in it.
    await kimWith(
      address,
      {},
      "draft",
      session.token,
      questions[1]!.id,
      "Welcome",
      "--send",
    );
    const file = join(tempDir(), "phone.png");
    const shot = JSON.parse(
      (
        await kimWith(
          address,
          { KIM_BROWSER: browser },
          "inbox",
          "screenshot",
          session.token,
          mockup.id,
          "--width",
          "390",
          "--full-page",
          "--out",
          file,
        )
      ).stdout,
    );
    expect(shot).toEqual({ file, width: 390, height: 844, revision: 1 });
    const png = readFileSync(file);
    expect(png.subarray(0, 8)).toEqual(Buffer.from(PNG.subarray(0, 8)));
    // Width and height from the PNG's header.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([390, 844]);
  }, 60_000);

  it("saves the page for the agent's own browser when there's none to render with", async () => {
    const { session, mockup, address } = await inboxHarness();
    const failed = await kimWith(
      address,
      { KIM_BROWSER: "/nowhere/chrome" },
      "inbox",
      "screenshot",
      session.token,
      mockup.id,
    ).catch((error: { stderr: string }) => error);
    const { error } = JSON.parse((failed as { stderr: string }).stderr);
    expect(error).toMatch(/KIM_BROWSER \(\/nowhere\/chrome\)/);
    const page = /saved at (\S+\.html):/.exec(error)?.[1];
    expect(page).toBeDefined();
    expect(readFileSync(page!, "utf8")).toContain(">Hello</h1>");
    expect(error).toMatch(/390px wide/);
  });

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

describe("design", { timeout: 30_000 }, () => {
  /** A repo with a data model in .kim/, and kim run from inside it. */
  /** The built design viewer, served as the Worker does: open to sandboxed frames. */
  const viewerFiles = (request: Request) => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/design-viewer/")) return null;
    const file = join(repo, "web-dist", pathname);
    if (!existsSync(file)) return new Response("missing", { status: 404 });
    return new Response(readFileSync(file), {
      headers: {
        "content-type": pathname.endsWith(".css")
          ? "text/css"
          : "text/javascript",
        "access-control-allow-origin": "*",
      },
    });
  };

  async function repoWithDesigns(browser = "/nowhere/chrome") {
    const { address } = await listeningHarness(viewerFiles);
    const dir = tempDir();
    const git = (...args: string[]) =>
      exec("git", args, { cwd: dir, env: env(address) });
    await git("init", "-q");
    mkdirSync(join(dir, ".kim/designs"), { recursive: true });
    writeFileSync(
      join(dir, ".kim/designs/data-model.dbml"),
      "Table users {\n  id uuid\n}\n",
    );
    await git("add", ".");
    await git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-q",
      "-m",
      "designs",
    );
    const run = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(process.execPath, [tsx, cli, ...args], {
            env: env(address, { KIM_BROWSER: browser }),
            cwd: dir,
          })
        ).stdout,
      );
    /** Runs it expecting a failure, for its exit code and output. */
    const attempt = (...args: string[]) =>
      exec(process.execPath, [tsx, cli, ...args], {
        env: env(address, { KIM_BROWSER: browser }),
        cwd: dir,
      }).then(
        () => ({ code: 0, stdout: "", stderr: "" }),
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
    return { dir, run, attempt };
  }

  it("pulls a design, keeps it, and writes it back when the interview stops", async () => {
    const { dir, run } = await repoWithDesigns();
    expect((await run("design", "list")).files).toEqual([
      {
        path: ".kim/designs/data-model.dbml",
        kind: "design",
        designType: "data-model",
      },
    ]);
    const session = await run("session", "create", "--title", "Plans table");
    const pulled = await run(
      "design",
      "pull",
      session.id,
      ".kim/designs/data-model.dbml",
    );
    const [design] = pulled.artifacts;
    expect(design).toMatchObject({
      kind: "design",
      designType: "data-model",
      keep: false,
      repo: { path: ".kim/designs/data-model.dbml", changed: false },
    });
    const changed = join(dir, "changed.dbml");
    writeFileSync(changed, "Table users {\n  id uuid\n  plan text\n}\n");
    await run("artifact", "update", session.id, design.id, "--file", changed);
    expect((await run("design", "keep", session.id, design.id)).keep).toBe(
      true,
    );
    const sequence = join(dir, "pull.mmd");
    writeFileSync(sequence, "sequenceDiagram\n  Agent->>kim: pull\n");
    await run(
      "artifact",
      "add",
      session.id,
      "--file",
      sequence,
      "--title",
      "Pull a design",
      "--keep",
    );
    expect(
      (await run("design", "write", session.id, "--dry-run")).plan,
    ).toEqual([
      expect.objectContaining({
        path: ".kim/designs/data-model.dbml",
        action: "update",
      }),
      expect.objectContaining({
        path: ".kim/designs/pull-a-design.mmd",
        action: "create",
      }),
    ]);

    const stopped = await run("session", "stop", session.id);
    expect(stopped.ok).toBe(true);
    expect(stopped.written.map((step: { path: string }) => step.path)).toEqual([
      ".kim/designs/data-model.dbml",
      ".kim/designs/pull-a-design.mmd",
    ]);
    expect(
      readFileSync(join(dir, ".kim/designs/data-model.dbml"), "utf8"),
    ).toContain("plan text");
    expect(
      readFileSync(join(dir, ".kim/designs/pull-a-design.mmd"), "utf8"),
    ).toContain("Agent->>kim");
    // The previews render in Cloudflare's browser; without it, the designs
    // are still written, and the agent hears why the previews aren't.
    expect(
      stopped.previewsFailed.map((item: { path: string }) => item.path),
    ).toEqual([
      ".kim/designs/data-model.svg",
      ".kim/designs/pull-a-design.svg",
    ]);
  });

  it("draws each written design's preview in a browser on this machine", async (context) => {
    let browser: string;
    try {
      browser = findBrowser();
    } catch {
      return context.skip("no Chrome, Edge or Chromium on this machine");
    }
    if (!existsSync(join(repo, "web-dist/design-viewer/viewer.js")))
      return context.skip("the design viewer isn't built (npm run build:web)");
    const { dir, run } = await repoWithDesigns(browser);
    const session = await run("session", "create", "--title", "Plans table");
    await run(
      "design",
      "pull",
      session.id,
      ".kim/designs/data-model.dbml",
      "--keep",
    );
    const written = await run("design", "write", session.id);
    expect(written.previewsFailed).toBeUndefined();
    expect(written.previews).toEqual([".kim/designs/data-model.svg"]);
    const svg = readFileSync(join(dir, ".kim/designs/data-model.svg"), "utf8");
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain("users");
  }, 60_000);

  it("leaves the interview running when the repo file changed since the copy", async () => {
    const { dir, run, attempt } = await repoWithDesigns();
    const session = await run("session", "create", "--title", "Plans table");
    const [design] = (
      await run(
        "design",
        "pull",
        session.id,
        ".kim/designs/data-model.dbml",
        "--keep",
      )
    ).artifacts;
    const ours = join(dir, "ours.dbml");
    writeFileSync(ours, "Table users {\n  id uuid\n  plan text\n}\n");
    await run("artifact", "update", session.id, design.id, "--file", ours);
    // Someone changed it on main meanwhile.
    const theirs = "Table users {\n  id uuid\n  name text\n}\n";
    writeFileSync(join(dir, ".kim/designs/data-model.dbml"), theirs);

    const failed = await attempt("session", "stop", session.id);
    expect(failed.code).toBe(1);
    const result = JSON.parse(failed.stdout);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ path: ".kim/designs/data-model.dbml" }),
    ]);
    expect(readFileSync(result.conflicts[0].theirs, "utf8")).toBe(theirs);
    expect(
      readFileSync(join(dir, ".kim/designs/data-model.dbml"), "utf8"),
    ).toBe(theirs);
    expect((await run("session", "show", session.id)).status).toBe("active");

    // The agent merges, rebases on the repo as it is now, and stops again.
    const merged = join(dir, "merged.dbml");
    writeFileSync(
      merged,
      "Table users {\n  id uuid\n  name text\n  plan text\n}\n",
    );
    const rebased = await run(
      "design",
      "rebase",
      session.id,
      design.id,
      "--file",
      merged,
    );
    expect(rebased.repo).toMatchObject({ changed: true });
    const stopped = await run("session", "stop", session.id);
    expect(stopped.written).toHaveLength(1);
    expect(
      readFileSync(join(dir, ".kim/designs/data-model.dbml"), "utf8"),
    ).toContain("name text\n  plan text");
  });

  it("brings the design system along with a mockup that uses it", async () => {
    const { dir, run } = await repoWithDesigns();
    mkdirSync(join(dir, ".kim/design-system"), { recursive: true });
    mkdirSync(join(dir, ".kim/mockups"), { recursive: true });
    writeFileSync(
      join(dir, ".kim/design-system/tokens.css"),
      ":root { --blue: #1f6bff; }",
    );
    writeFileSync(
      join(dir, ".kim/mockups/landing.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="../design-system/tokens.css"></head><body></body></html>',
    );
    const session = await run("session", "create", "--title", "Landing");
    const { artifacts } = await run(
      "design",
      "pull",
      session.id,
      ".kim/mockups/landing.html",
    );
    expect(
      artifacts.map((item: { kind: string; title: string }) => [
        item.kind,
        item.title,
      ]),
    ).toEqual([
      ["tokens", "Design system"],
      ["mockup", "Landing"],
    ]);
    // Once is enough.
    const again = await run(
      "design",
      "pull",
      session.id,
      ".kim/mockups/landing.html",
    );
    expect(again.artifacts.map((item: { kind: string }) => item.kind)).toEqual([
      "mockup",
    ]);
  });

  it("still writes back after the repo gets a remote", async () => {
    const { dir, run } = await repoWithDesigns();
    const session = await run("session", "create", "--title", "Plans table");
    await run(
      "design",
      "pull",
      session.id,
      ".kim/designs/data-model.dbml",
      "--keep",
    );
    // The project key was local/<folder>; now it's the remote's.
    await exec(
      "git",
      ["remote", "add", "origin", "https://github.com/acme/storefront.git"],
      { cwd: dir },
    );
    const written = await run("design", "write", session.id, "--dry-run");
    expect(written.plan).toEqual([
      expect.objectContaining({ path: ".kim/designs/data-model.dbml" }),
    ]);
  });

  it("won't keep a past plan", async () => {
    const { dir, attempt, run } = await repoWithDesigns();
    mkdirSync(join(dir, ".kim/plans"), { recursive: true });
    writeFileSync(join(dir, ".kim/plans/2026-10-01-old.md"), "# Old");
    const session = await run("session", "create", "--title", "Plans table");
    const failed = await attempt(
      "design",
      "pull",
      session.id,
      ".kim/plans/2026-10-01-old.md",
      "--keep",
    );
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("past plan");
  });
});
