import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindingChanges,
  readBindings,
  runHook,
  TAKE_THROTTLE_MS,
  type Batch,
  type HookPayload,
  type TakeOutcome,
} from "../src/hook.js";
import { hubHarness } from "./helpers/harness.js";
import { homeEnv } from "./helpers/home.js";
import { serveHarness } from "./helpers/serve.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kim-hook-test-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ID = "0b9f6a52-8d1e-4c1a-9a57-3f2a1e7c9d10";
const OTHER = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

const batch = (events: unknown[] = [], extra: Partial<Batch> = {}): Batch => ({
  events,
  messages: [],
  answers: events.length
    ? [{ questionId: "q", number: 1, prompt: "One?", answer: "Yes" }]
    : [],
  openQuestions: 1,
  stageVisible: false,
  status: "active",
  ...extra,
});

/** A Bash call as Claude Code reports it to PostToolUse. */
const bash = (command: string, stdout = "", session = "s1"): HookPayload => ({
  session_id: session,
  cwd: "/repo",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
});

function setup() {
  const stateFile = join(tempDir(), "hooks.json");
  const take = vi.fn(async (): Promise<TakeOutcome> => ({ batch: batch() }));
  const run = (
    event: "PostToolUse" | "UserPromptSubmit" | "SessionStart",
    payload: HookPayload,
    now = Date.parse("2026-10-30T09:00:00Z"),
  ) => runHook(event, payload, { stateFile, take, now });
  return { stateFile, take, run };
}

describe("binding interviews to an agent session", () => {
  it("finds the interview in what session create and ask print", () => {
    expect(
      bindingChanges(
        bash(
          'kim session create --title "Plan"',
          `${JSON.stringify({ id: ID, url: "https://k/s/t", questions: [] })}\n`,
        ),
      ),
    ).toEqual({ bind: [ID], unbind: [], inbox: [] });
    expect(
      bindingChanges(
        bash(
          "cd /repo && kim ask --title T --prompt P",
          JSON.stringify({ interviewId: ID, url: "u", events: [] }),
        ),
      ).bind,
    ).toEqual([ID]);
  });

  it("finds it in a kim command's arguments, and forgets it on stop or delete", () => {
    expect(
      bindingChanges(bash(`kim question add ${ID} --prompt "Why?"`)).bind,
    ).toEqual([ID]);
    expect(bindingChanges(bash(`kim wait '${ID}'`)).bind).toEqual([ID]);
    expect(
      bindingChanges(
        bash(`kim session stop ${ID}; kim session delete ${OTHER}`),
      ),
    ).toEqual({ bind: [], unbind: [ID, OTHER], inbox: [] });
  });

  it("ignores other commands, and ids that kim didn't print", () => {
    expect(
      bindingChanges(bash(`echo ${ID}`, JSON.stringify({ id: ID }))),
    ).toEqual({
      bind: [],
      unbind: [],
      inbox: [],
    });
    // session list prints every interview's id; that binds none of them.
    expect(
      bindingChanges(bash("kim session list", JSON.stringify([{ id: ID }])))
        .bind,
    ).toEqual([]);
  });

  it("reads Codex's payloads, whose tool response may be plain text", () => {
    expect(
      bindingChanges({
        session_id: "c1",
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: ["bash", "-lc", "kim ask --prompt P"] },
        tool_response: JSON.stringify({ interviewId: ID }),
      }).bind,
    ).toEqual([ID]);
  });
});

describe("kim hook", () => {
  it("costs no network for a session with no interviews, and writes nothing", async () => {
    const { run, take, stateFile } = setup();
    expect(await run("PostToolUse", bash("npm test"))).toEqual({});
    expect(
      await run("UserPromptSubmit", { session_id: "s1", cwd: "/repo" }),
    ).toEqual({});
    expect(
      await run("SessionStart", { session_id: "s1", cwd: "/repo" }),
    ).toEqual({});
    expect(take).not.toHaveBeenCalled();
    expect(existsSync(stateFile)).toBe(false);
  });

  it("injects answers after a tool call as PostToolUse context, like kim wait's output", async () => {
    const { run, take, stateFile } = setup();
    take.mockResolvedValue({
      batch: batch([{ id: 1, type: "answer.submitted" }]),
    });
    const response = await run(
      "PostToolUse",
      bash(
        `kim question add ${ID} --prompt P`,
        JSON.stringify({ questions: [] }),
      ),
    );
    expect(take).toHaveBeenCalledWith(ID, expect.anything());
    const output = response.hookSpecificOutput as Record<string, string>;
    expect(output.hookEventName).toBe("PostToolUse");
    const [intro, json] = output.additionalContext!.split("\n");
    expect(intro).toContain("arrived while you were working");
    expect(intro).toContain("kim wait");
    expect(JSON.parse(json!)).toMatchObject({
      interviewId: ID,
      answers: [{ prompt: "One?", answer: "Yes" }],
      openQuestions: 1,
    });
    expect(readBindings(stateFile)).toEqual([
      expect.objectContaining({
        interviewId: ID,
        agentSessionId: "s1",
        cwd: "/repo",
      }),
    ]);
  });

  it("takes at most every 15 s between tool calls, and on every prompt", async () => {
    const { run, take } = setup();
    const start = Date.parse("2026-10-30T09:00:00Z");
    await run("PostToolUse", bash(`kim wait ${ID}`), start);
    expect(take).toHaveBeenCalledTimes(1);
    await run("PostToolUse", bash("ls"), start + 5_000);
    expect(take).toHaveBeenCalledTimes(1);
    await run(
      "UserPromptSubmit",
      { session_id: "s1", cwd: "/repo" },
      start + 6_000,
    );
    expect(take).toHaveBeenCalledTimes(2);
    await run("PostToolUse", bash("ls"), start + 6_000 + TAKE_THROTTLE_MS - 1);
    expect(take).toHaveBeenCalledTimes(2);
    await run("PostToolUse", bash("ls"), start + 6_000 + TAKE_THROTTLE_MS);
    expect(take).toHaveBeenCalledTimes(3);
    // Another agent session's calls don't take this one's interviews.
    await run(
      "UserPromptSubmit",
      { session_id: "s2", cwd: "/repo" },
      start + 60_000,
    );
    expect(take).toHaveBeenCalledTimes(3);
  });

  it("brings in answers for the folder's recent interviews at session start, from any session", async () => {
    const { run, take } = setup();
    const start = Date.parse("2026-10-30T09:00:00Z");
    await run("PostToolUse", bash(`kim wait ${ID}`), start);
    take.mockClear();
    take.mockResolvedValue({
      batch: batch([{ id: 2, type: "answer.submitted" }]),
    });
    const response = await run(
      "SessionStart",
      { session_id: "new", cwd: "/repo" },
      start + 60_000,
    );
    expect(take).toHaveBeenCalledWith(ID, expect.anything());
    expect(
      (response.hookSpecificOutput as Record<string, string>).hookEventName,
    ).toBe("SessionStart");
    take.mockClear();
    expect(
      await run("SessionStart", { session_id: "new", cwd: "/elsewhere" }),
    ).toEqual({});
    expect(
      await run(
        "SessionStart",
        { session_id: "new", cwd: "/repo" },
        start + 8 * 24 * 60 * 60 * 1000,
      ),
    ).toEqual({});
    expect(take).not.toHaveBeenCalled();
  });

  it("says nothing when there's nothing new, and forgets finished interviews", async () => {
    const { run, take, stateFile } = setup();
    expect(await run("PostToolUse", bash(`kim wait ${ID}`))).toEqual({});
    take.mockResolvedValue("gone");
    await run("UserPromptSubmit", { session_id: "s1", cwd: "/repo" });
    expect(readBindings(stateFile)).toEqual([]);

    take.mockResolvedValue({
      batch: batch([{ id: 3 }], { status: "stopped" }),
    });
    // A stopped interview's last answers still arrive, then it's forgotten.
    const last = await run("PostToolUse", bash(`kim wait ${OTHER}`));
    expect(last.hookSpecificOutput).toBeDefined();
    expect(readBindings(stateFile)).toEqual([]);
    take.mockClear();
    await run("UserPromptSubmit", { session_id: "s1", cwd: "/repo" });
    expect(take).not.toHaveBeenCalled();
  });

  it("forgets an interview the agent stops itself, without asking the service", async () => {
    const { run, take, stateFile } = setup();
    await run("PostToolUse", bash(`kim wait ${ID}`));
    take.mockClear();
    await run(
      "PostToolUse",
      bash(`kim session stop ${ID}`),
      Date.now() + 60_000,
    );
    expect(readBindings(stateFile)).toEqual([]);
    expect(take).not.toHaveBeenCalled();
  });
});

describe("kim hook, end to end", () => {
  const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
    .pathname;
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;

  /** Runs `kim hook <event>` with `stdin`, like an agent would. */
  const hook = (
    event: string,
    stdin: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; code: number; ms: number }> =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = execFile(
        process.execPath,
        [tsx, cli, "hook", event],
        { env },
        (error, stdout) =>
          resolve({
            stdout,
            code: error ? Number(error.code ?? 1) : 0,
            ms: Date.now() - started,
          }),
      );
      child.stdin!.end(stdin);
    });

  async function served() {
    const harness = hubHarness();
    const server = await serveHarness(harness);
    cleanups.push(async () => {
      await server.close();
      setTimeout(() => harness.sql.close(), 3_000).unref();
    });
    const home = tempDir();
    return {
      ...harness,
      env: homeEnv(home, {
        KEEP_IT_MOVING_URL: server.address,
        KEEP_IT_MOVING_TOKEN: "test",
      }),
    };
  }

  it("binds from kim's output, then brings in the user's answers", async () => {
    const { store, env } = await served();
    const session = store.createSession("", { title: "Plan" });
    const [question] = store.addQuestions(session.id, [
      { type: "text", prompt: "Ship it?" },
    ]);
    const payload = (command: string, stdout: string) =>
      JSON.stringify({
        session_id: "agent-1",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/repo",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command, description: "Create an interview" },
        tool_response: {
          stdout,
          stderr: "",
          interrupted: false,
          isImage: false,
        },
        tool_use_id: "toolu_1",
      });
    const first = await hook(
      "post-tool-use",
      payload(
        'kim session create --title "Plan"',
        JSON.stringify({ id: session.id }),
      ),
      env,
    );
    expect(first).toMatchObject({ code: 0 });
    expect(JSON.parse(first.stdout)).toEqual({});

    store.answerQuestion(session.id, question!.id, { answer: "Yes" });
    // The last open question settles briefly, as on the socket.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const prompt = await hook(
      "user-prompt-submit",
      JSON.stringify({
        session_id: "agent-1",
        cwd: "/repo",
        hook_event_name: "UserPromptSubmit",
        prompt: "go on",
      }),
      env,
    );
    const response = JSON.parse(prompt.stdout);
    expect(response.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(response.hookSpecificOutput.additionalContext).toContain(
      '"answer":"Yes"',
    );
    expect(store.undeliveredEvents(session.id)).toEqual([]);
  }, 30_000);

  it("prints {} and exits 0 on garbage, an unknown event, or a service that's down", async () => {
    const { env } = await served();
    for (const [event, stdin] of [
      ["post-tool-use", "not json"],
      ["stop", "{}"],
    ] as const)
      expect(await hook(event, stdin, env)).toMatchObject({
        stdout: "{}\n",
        code: 0,
      });
    const down = {
      ...env,
      KEEP_IT_MOVING_URL: "http://10.255.255.1:9",
    };
    await hook("post-tool-use", JSON.stringify(bash(`kim wait ${ID}`)), down);
    const result = await hook(
      "user-prompt-submit",
      JSON.stringify({ session_id: "s1", cwd: "/repo" }),
      down,
    );
    expect(result).toMatchObject({ stdout: "{}\n", code: 0 });
    // Two seconds for the network, plus starting node and tsx.
    expect(result.ms).toBeLessThan(5_000);
  }, 30_000);
});

describe("interviews sent to the user", () => {
  const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

  it("bind from the inbox commands that name one, by token or url", () => {
    expect(
      bindingChanges(bash(`kim draft ${TOKEN} 2 --option Big`)).inbox,
    ).toEqual([TOKEN]);
    expect(
      bindingChanges(
        bash(`kim inbox show https://kim.test/s/${TOKEN} && kim inbox`),
      ),
    ).toEqual({ bind: [], unbind: [], inbox: [TOKEN] });
    // Listing, or waiting on everything, names none.
    expect(
      bindingChanges(bash("kim inbox wait --timeout 600000")).inbox,
    ).toEqual([]);
  });

  it("bring the sender's changes in through the hook, like inbox wait's output", async () => {
    const { run, take, stateFile } = setup();
    take.mockResolvedValue({
      news: {
        news: true,
        id: TOKEN,
        questions: [{ number: 3, prompt: "Budget?" }],
        status: "active",
      },
    });
    await run("PostToolUse", bash(`kim inbox show ${TOKEN}`));
    expect(take).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ inbox: true }),
    );
    expect(readBindings(stateFile)).toEqual([
      expect.objectContaining({ interviewId: TOKEN, inbox: true }),
    ]);
    const response = await run(
      "UserPromptSubmit",
      { session_id: "s1", cwd: "/repo" },
      Date.parse("2026-10-30T09:05:00Z"),
    );
    const context = (response.hookSpecificOutput as Record<string, string>)
      .additionalContext!;
    expect(context).toContain(`changes to interview ${TOKEN}`);
    expect(context).toContain("kim inbox wait");
    expect(context).toContain("Budget?");
    // Nothing new: nothing said.
    take.mockResolvedValue({ news: { news: false, status: "active" } });
    expect(
      await run(
        "UserPromptSubmit",
        { session_id: "s1", cwd: "/repo" },
        Date.parse("2026-10-30T09:10:00Z"),
      ),
    ).toEqual({});
    // Only in the agent session that worked on it.
    take.mockClear();
    await run(
      "UserPromptSubmit",
      { session_id: "s2", cwd: "/repo" },
      Date.parse("2026-10-30T09:15:00Z"),
    );
    expect(take).not.toHaveBeenCalled();
  });
});
