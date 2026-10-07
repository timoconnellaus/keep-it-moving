import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve(
      { fetch: harness.app.fetch, hostname: "127.0.0.1", port: 0 },
      () => resolve(started),
    );
  });
  const { port } = server.address() as AddressInfo;
  cleanups.push(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    harness.sql.close();
  });
  return { ...harness, address: `http://127.0.0.1:${port}` };
}

const env = (address: string, extra: Record<string, string> = {}) => {
  const base = { ...process.env };
  delete base.CLAUDE_CODE_SESSION_ID;
  delete base.CLAUDE_CODE_REMOTE;
  return {
    ...base,
    INTERVIEWER_URL: address,
    INTERVIEWER_TOKEN: "test",
    ...extra,
  };
};

/** Runs `interviewer hook <event>` with JSON on stdin, as Claude Code does. */
function runHook(address: string, event: string, input: unknown) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(process.execPath, [tsx, cli, "hook", event], {
        env: env(address),
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
    ).toEqual(["afplay /System/done.aiff", "interviewer hook Stop"]);
    expect(installed.hooks.Notification[0].hooks[0].command).toBe(
      "interviewer hook Notification",
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
