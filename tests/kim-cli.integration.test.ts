import { execFile, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { hubHarness } from "./helpers/harness.js";

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
  const dir = mkdtempSync(join(tmpdir(), "interviewer-kim-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listeningHarness() {
  const harness = hubHarness();
  /** Every request's method and path, in order. */
  const requests: string[] = [];
  const fetch = (request: Request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return harness.app.fetch(request);
  };
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch, hostname: "127.0.0.1", port: 0 }, () =>
      resolve(started),
    );
  });
  const { port } = server.address() as AddressInfo;
  cleanups.push(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    // The hub checks for push a couple of seconds after questions arrive;
    // later tests keep the process alive, so close the database after that.
    setTimeout(() => harness.sql.close(), 3_000).unref();
  });
  return { ...harness, requests, address: `http://127.0.0.1:${port}` };
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

/** Runs `kim hook <event>` with JSON on stdin, as Claude Code does. */
function runHook(
  address: string,
  event: string,
  input: unknown,
  extra: Record<string, string> = {},
) {
  // Its own temp dir, so another run's dedupe markers never match.
  const markers = tempDir();
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(process.execPath, [tsx, cli, "hook", event], {
        env: env(address, { TMPDIR: markers, ...extra }),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(input));
    },
  );
}

describe("hooks install", () => {
  it("merges its hooks beside existing ones, idempotently, and uninstalls only its own", async () => {
    const dir = tempDir();
    const settings = join(dir, "settings.json");
    const original = {
      model: "opus",
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "afplay /System/done.aiff" }] },
        ],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "guard" }] },
        ],
      },
    };
    writeFileSync(settings, JSON.stringify(original));
    const run = async (action: string) =>
      JSON.parse(
        (
          await exec(process.execPath, [
            tsx,
            cli,
            "hooks",
            action,
            "--settings",
            settings,
          ])
        ).stdout,
      );
    const read = () => JSON.parse(readFileSync(settings, "utf8"));

    expect((await run("install")).changed).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Notification",
      "Stop",
      "SessionEnd",
    ]);
    const installed = read();
    expect(installed.model).toBe("opus");
    expect(installed.hooks.PreToolUse).toEqual(original.hooks.PreToolUse);
    expect(
      installed.hooks.Stop.map(
        (group: { hooks: Array<{ command: string }> }) =>
          group.hooks[0]!.command,
      ),
    ).toEqual(["afplay /System/done.aiff", "kim hook Stop"]);
    expect(installed.hooks.Notification[0].hooks[0].command).toBe(
      "kim hook Notification",
    );

    expect((await run("install")).changed).toEqual([]);
    expect(read()).toEqual(installed);

    await run("uninstall");
    expect(read()).toEqual(original);
  });
});

describe("hook command", () => {
  it("maps Claude Code hooks to session reports, and never fails", async () => {
    const { address, app } = await listeningHarness();
    const dir = tempDir();
    const transcript = join(dir, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        { type: "user", message: { content: "Fix the lease" } },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Looking now." }] },
        },
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Fixed the watcher lease; tests pass." },
              { type: "tool_use", name: "Bash" },
            ],
          },
        },
        { type: "assistant", message: { content: [{ type: "tool_use" }] } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    const base = { session_id: "cc-1", cwd: repo, transcript_path: transcript };
    const session = async () =>
      (
        await app.inject({
          method: "GET",
          url: "/api/browser/kim/sessions/cc-1",
        })
      ).json();

    const started = await runHook(address, "UserPromptSubmit", {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt: `  Fix the watcher lease\n so a dead CLI ${"never blocks ".repeat(10)}`,
    });
    expect(started).toEqual({ code: 0, stdout: "", stderr: "" });
    const running = await session();
    expect(running.status).toBe("running");
    expect(running.title).toHaveLength(80);
    expect(
      running.title.startsWith("Fix the watcher lease so a dead CLI"),
    ).toBe(true);
    expect(running.cwd).toBe(repo);
    expect(running.location).toBe("local");
    expect(running.machine).toBeTruthy();
    expect(running.projectId).toBeTruthy();

    await runHook(address, "Notification", {
      ...base,
      message: "Claude needs your permission to use Bash",
    });
    expect(await session()).toMatchObject({
      status: "needs_you",
      message: "Claude needs your permission to use Bash",
    });

    await runHook(address, "Stop", base);
    expect(await session()).toMatchObject({
      status: "idle",
      brief: "Fixed the watcher lease; tests pass.",
    });

    await runHook(address, "SessionEnd", base);
    expect((await session()).status).toBe("done");

    // Bad input, an unknown event and an unreachable server all exit quietly.
    expect(await runHook(address, "Stop", "not json")).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    expect(await runHook(address, "PreToolUse", base)).toMatchObject({
      code: 0,
      stdout: "",
    });
    expect(await runHook("http://127.0.0.1:9", "Stop", base)).toMatchObject({
      code: 0,
      stdout: "",
    });
  });
});

describe("report and ask", () => {
  it("reports explicitly, ignoring a missing follow-ups route", async () => {
    const { address } = await listeningHarness();
    const { stdout } = await exec(
      process.execPath,
      [
        tsx,
        cli,
        "report",
        "--status",
        "idle",
        "--brief",
        "Opened the PR",
        "--pr",
        "https://github.com/o/r/pull/3",
        "--follow-up",
        "Add rate limiting",
      ],
      { env: env(address, { CLAUDE_CODE_SESSION_ID: "cc-2" }), cwd: repo },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      id: "cc-2",
      status: "idle",
      brief: "Opened the PR",
      prUrl: "https://github.com/o/r/pull/3",
    });
  });

  it("raises a request linked to the agent session and waits", async () => {
    const { address, app, store } = await listeningHarness();
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        tsx,
        cli,
        "ask",
        "--title",
        "Run the migration?",
        "--brief",
        "Migration is ready.",
        "--prompt",
        "Back up first?",
        "--type",
        "yes-no",
        "--timeout",
        "500",
      ],
      { env: env(address, { CLAUDE_CODE_SESSION_ID: "cc-3" }), cwd: repo },
    );
    const result = JSON.parse(stdout);
    expect(stderr).toContain(result.url);
    expect(result).toMatchObject({
      events: expect.any(Array),
      openQuestions: 1,
    });
    const items = (
      await app.inject({ method: "GET", url: "/api/browser/kim/inbox" })
    ).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "request",
      title: "Run the migration?",
      brief: "Migration is ready.",
    });
    expect(store.getSession(result.interviewId, "").questions[0]!.prompt).toBe(
      "Back up first?",
    );
    const session = (
      await app.inject({ method: "GET", url: "/api/browser/kim/sessions/cc-3" })
    ).json();
    expect(session.status).toBe("needs_you");
    expect(session.requests[0]).toMatchObject({
      id: result.interviewId,
      open: 1,
    });
  });
});

describe("project summaries", () => {
  it("prints the project's context and saves a summary from text or a file", async () => {
    const { address } = await listeningHarness();
    const run = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(process.execPath, [tsx, cli, ...args], {
            env: env(address, { CLAUDE_CODE_SESSION_ID: "cc-sum" }),
            cwd: repo,
          })
        ).stdout,
      );
    await run("report", "--title", "Summaries", "--brief", "Routes done");
    const saved = await run(
      "project",
      "summary",
      "--text",
      "Routes are in; the page is next.",
    );
    expect(saved.summary).toMatchObject({
      text: "Routes are in; the page is next.",
      writtenBy: "cc-sum",
      writtenByTitle: "Summaries",
    });
    const file = join(tempDir(), "summary.md");
    writeFileSync(file, "The page shows it now.\n");
    await run("project", "summary", "--file", file);
    const context = await run("project", "context");
    expect(context.project.key).toBe(saved.project.key);
    expect(context.sessions[0]).toMatchObject({
      id: "cc-sum",
      brief: "Routes done",
    });
    expect(context.previousSummary.text).toBe("The page shows it now.");
  });
});

const cloud = {
  CLAUDE_CODE_REMOTE: "true",
  CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01Cloud",
};

describe("cloud sessions", () => {
  it("links the hooks' session to report and ask by the remote id", async () => {
    const { address, app } = await listeningHarness();
    const session = async () =>
      (
        await app.inject({
          method: "GET",
          url: "/api/browser/kim/sessions/cc-cloud",
        })
      ).json();
    await runHook(
      address,
      "SessionStart",
      { session_id: "cc-cloud", cwd: repo },
      cloud,
    );
    expect(await session()).toMatchObject({
      location: "cloud",
      remoteId: "cse_01Cloud",
      url: "https://claude.ai/code/session_01Cloud",
    });

    // No CLAUDE_CODE_SESSION_ID: the remote id finds the hooks' session.
    const reported = JSON.parse(
      (
        await exec(
          process.execPath,
          [tsx, cli, "report", "--status", "idle", "--brief", "Pushed"],
          { env: env(address, cloud), cwd: repo },
        )
      ).stdout,
    );
    expect(reported).toMatchObject({ id: "cc-cloud", brief: "Pushed" });

    const asked = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            tsx,
            cli,
            "ask",
            "--title",
            "Ship?",
            "--prompt",
            "Ship it?",
            "--timeout",
            "300",
          ],
          { env: env(address, cloud), cwd: repo },
        )
      ).stdout,
    );
    const asking = await session();
    expect(asking.status).toBe("needs_you");
    expect(asking.requests[0].id).toBe(asked.interviewId);
  });

  it("reports under the remote id before any hook has", async () => {
    const { address } = await listeningHarness();
    const { stdout } = await exec(
      process.execPath,
      [tsx, cli, "report", "--brief", "Early"],
      { env: env(address, cloud), cwd: repo },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      id: "cse_01Cloud",
      url: "https://claude.ai/code/session_01Cloud",
    });
  });

  it("reports once when user and project hooks both fire", async () => {
    const { address, requests } = await listeningHarness();
    const markers = tempDir();
    const input = { session_id: "cc-twice", cwd: repo };
    await Promise.all([
      runHook(address, "Stop", input, { TMPDIR: markers }),
      runHook(address, "Stop", input, { TMPDIR: markers }),
    ]);
    expect(
      requests.filter((request) => request === "POST /api/sessions/kim/report"),
    ).toHaveLength(1);
  });
});

describe("hooks install --project", () => {
  it("merges guarded hooks into the repo's settings, idempotently, and commits nothing", async () => {
    const dir = tempDir();
    await exec("git", ["init", "-q", dir]);
    mkdirSync(join(dir, ".claude"));
    const settings = join(dir, ".claude", "settings.json");
    const original = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "npm run lint" }] }],
      },
    };
    writeFileSync(settings, JSON.stringify(original));
    const run = async (action: string) => {
      const { stdout, stderr } = await exec(
        process.execPath,
        [tsx, cli, "hooks", action, "--project"],
        { cwd: dir, env: env("http://127.0.0.1:9") },
      );
      return { result: JSON.parse(stdout), stderr };
    };
    const read = () => JSON.parse(readFileSync(settings, "utf8"));
    const guarded = (event: string) =>
      `[ -n "$KEEP_IT_MOVING_TOKEN$INTERVIEWER_TOKEN" ] && kim hook ${event} || true`;

    const first = await run("install");
    expect(first.result.changed).toHaveLength(5);
    expect(first.result.commit).toContain("add .claude/settings.json");
    expect(first.stderr).toContain("Nothing is committed");
    const installed = read();
    expect(installed.permissions).toEqual(original.permissions);
    expect(
      installed.hooks.Stop.map(
        (group: { hooks: Array<{ command: string }> }) =>
          group.hooks[0]!.command,
      ),
    ).toEqual(["npm run lint", guarded("Stop")]);
    expect(installed.hooks.SessionStart[0].hooks[0].command).toBe(
      guarded("SessionStart"),
    );

    const again = await run("install");
    expect(again.result).toMatchObject({ changed: [], commit: null });
    expect(read()).toEqual(installed);
    // Nothing committed: the repo still has no commits.
    await expect(
      exec("git", ["-C", dir, "rev-parse", "--verify", "HEAD"]),
    ).rejects.toThrow();

    // Under sh the guard runs nothing without a token, and always exits 0.
    const sh = (token?: string) =>
      new Promise<number | null>((resolve) => {
        const shellEnv: Record<string, string> = { PATH: dir };
        if (token) shellEnv.KEEP_IT_MOVING_TOKEN = token;
        spawn("/bin/sh", ["-c", guarded("Stop")], { env: shellEnv }).on(
          "close",
          resolve,
        );
      });
    expect(await sh()).toBe(0);
    // With a token it runs interviewer, missing from this PATH: still 0.
    expect(await sh("kim_x")).toBe(0);

    await run("uninstall");
    expect(read()).toEqual(original);
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
    expect(stdout).toContain("kim hooks install || true");
    expect(stdout).toContain("kim hooks install --project");
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
      "package/dist/cli.js",
      "package/dist/shared/automations.js",
      "package/dist/shared/remote.js",
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
      [tsx, cli, "automation", "list", "--all"],
      { env: { ...base, INTERVIEWER_URL: address, INTERVIEWER_TOKEN: "test" } },
    );
    expect(JSON.parse(stdout)).toEqual({ automations: [] });
    expect(requests).toContain("GET /api/sessions/kim/automations");
  });
});
