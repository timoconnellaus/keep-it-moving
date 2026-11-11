import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armWaiter,
  bindingChanges,
  disarmWaiter,
  endSession,
  readBindings,
  runHook,
  runStop,
  TAKE_THROTTLE_MS,
  waiterArmed,
  type StopWaitOutcome,
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
const THIRD = "3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7";

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
    ).toEqual({ bind: [ID], unbind: [], inbox: [], started: [ID] });
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

  it("takes the session's own interview at every tool call, and only its own", async () => {
    const { run, take } = setup();
    const start = Date.parse("2026-10-30T09:00:00Z");
    await run("PostToolUse", bash(`kim wait ${ID}`), start);
    expect(take).toHaveBeenCalledTimes(1);
    await run("PostToolUse", bash("ls"), start + 1_000);
    expect(take).toHaveBeenCalledTimes(2);
    await run(
      "UserPromptSubmit",
      { session_id: "s1", cwd: "/repo" },
      start + 2_000,
    );
    expect(take).toHaveBeenCalledTimes(3);
    // Another agent session's calls don't take this one's interviews.
    await run(
      "UserPromptSubmit",
      { session_id: "s2", cwd: "/repo" },
      start + 60_000,
    );
    expect(take).toHaveBeenCalledTimes(3);
  });

  it("holds several interviews per session: starting one adds it, looking at one doesn't", async () => {
    const { run, stateFile, take } = setup();
    const own = () =>
      readBindings(stateFile)
        .filter((binding) => binding.agentSessionId === "s1")
        .map((binding) => binding.interviewId)
        .sort();
    await run(
      "PostToolUse",
      bash("kim session create --title A", JSON.stringify({ id: ID })),
    );
    expect(own()).toEqual([ID]);
    // Reading an old interview leaves the session on its own.
    await run("PostToolUse", bash(`kim session show ${OTHER}`));
    expect(own()).toEqual([ID]);
    await run("PostToolUse", bash(`kim question add ${ID} --prompt P`));
    expect(own()).toEqual([ID]);
    // Resuming another adds it alongside.
    await run("PostToolUse", bash(`kim session resume ${OTHER}`));
    expect(own()).toEqual([ID, OTHER].sort());
    // Every tool call takes both.
    take.mockClear();
    await run("PostToolUse", bash("ls"), Date.parse("2026-10-30T09:01:00Z"));
    expect(take.mock.calls.map(([id]) => id).sort()).toEqual(
      [ID, OTHER].sort(),
    );
    // Stopping one leaves the other.
    await run("PostToolUse", bash(`kim session stop ${OTHER}`));
    expect(own()).toEqual([ID]);
    await run("PostToolUse", bash(`kim session stop ${ID}`));
    expect(own()).toEqual([]);
    // With none, the next one it names binds.
    await run("PostToolUse", bash(`kim wait ${ID}`));
    expect(own()).toEqual([ID]);
  });

  it("never takes another live session's interview by naming it; only resuming it does", async () => {
    const { run, stateFile, take } = setup();
    const holder = () =>
      readBindings(stateFile).find((binding) => binding.interviewId === ID)
        ?.agentSessionId;
    await run(
      "PostToolUse",
      bash("kim session create --title A", JSON.stringify({ id: ID }), "s1"),
    );
    expect(holder()).toBe("s1");
    // Another session, with no interview of its own, looks at it: listing
    // it or screenshotting one of its artifacts doesn't move it.
    take.mockClear();
    await run(
      "PostToolUse",
      bash(`kim artifact screenshot ${ID} a1 --out x.png`, "", "s2"),
    );
    await run(
      "PostToolUse",
      bash("kim session list", JSON.stringify({ interviewId: ID }), "s2"),
    );
    expect(holder()).toBe("s1");
    expect(take).not.toHaveBeenCalled();
    // Resuming it is a deliberate takeover.
    await run("PostToolUse", bash(`kim session resume ${ID}`, "", "s2"));
    expect(holder()).toBe("s2");
  });

  it("lets the next session carry on an interview once its session ended", async () => {
    const { run, stateFile } = setup();
    await run(
      "PostToolUse",
      bash("kim session create --title A", JSON.stringify({ id: ID }), "s1"),
    );
    endSession(stateFile, "s1");
    await run("PostToolUse", bash(`kim wait ${ID}`, "", "s2"));
    expect(
      readBindings(stateFile).find((binding) => binding.interviewId === ID),
    ).toMatchObject({ agentSessionId: "s2" });
    expect(
      readBindings(stateFile).find((binding) => binding.interviewId === ID)
        ?.endedAt,
    ).toBeUndefined();
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
    extra: string[] = [],
  ): Promise<{ stdout: string; stderr: string; code: number; ms: number }> =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = execFile(
        process.execPath,
        [tsx, cli, "hook", event, ...extra],
        { env },
        (error, stdout, stderr) =>
          resolve({
            stdout,
            stderr,
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

  it("wakes Claude from the Stop hook with the answers, or hands them to Codex's hold", async () => {
    const { store, env } = await served();
    const session = store.createSession("", { title: "Plan" });
    const [one, two] = store.addQuestions(session.id, [
      { type: "text", prompt: "Ship it?" },
      { type: "text", prompt: "When?" },
    ]);
    const bind = (agent: string) =>
      hook(
        "post-tool-use",
        JSON.stringify({
          session_id: agent,
          cwd: "/repo",
          tool_name: "Bash",
          tool_input: { command: `kim wait ${session.id}` },
          tool_response: { stdout: "" },
        }),
        env,
      );
    const stopping = (agent: string, extra: string[] = []) =>
      hook(
        "stop",
        JSON.stringify({ session_id: agent, hook_event_name: "Stop" }),
        env,
        extra,
      );

    await bind("claude-1");
    const woken = stopping("claude-1");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    store.answerQuestion(session.id, one!.id, { answer: "Yes" });
    store.answerQuestion(session.id, two!.id, { answer: "Friday" });
    const claude = await woken;
    expect(claude.code).toBe(2);
    expect(claude.stderr).toContain(
      `Keep it moving: answers to interview ${session.id} arrived while you were waiting`,
    );
    expect(claude.stderr).toContain('"answer":"Friday"');

    // Claude's session ends; Codex carries the interview on.
    await hook("session-end", JSON.stringify({ session_id: "claude-1" }), env);
    await bind("codex-1");
    const held = stopping("codex-1", ["--hold"]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    store.answerQuestion(session.id, one!.id, { answer: "No" });
    const codex = await held;
    expect(codex.code).toBe(0);
    const response = JSON.parse(codex.stdout);
    expect(response.decision).toBe("block");
    expect(response.reason).toContain('"answer":"No"');
  }, 60_000);

  it("runs several interviews in one Claude session, and wakes on whichever the user answers", async () => {
    const { store, env } = await served();
    const agent = { ...env, CLAUDE_CODE_SESSION_ID: "claude-1" };
    const kim = (...args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(
          process.execPath,
          [tsx, cli, ...args],
          { env: agent },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        ),
      );
    const first = JSON.parse(await kim("session", "create", "--title", "A"))
      .id as string;
    const second = JSON.parse(await kim("session", "create", "--title", "B"))
      .id as string;
    store.addQuestions(first, [{ type: "text", prompt: "First?" }]);
    const [question] = store.addQuestions(second, [
      { type: "text", prompt: "Second?" },
    ]);
    const woken = hook("stop", JSON.stringify({ session_id: "claude-1" }), env);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    store.answerQuestion(second, question!.id, { answer: "Yes" });
    const result = await woken;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`answers to interview ${second}`);
    expect(result.stderr).not.toContain(`answers to interview ${first}`);
  }, 60_000);

  it("links Codex's session from CODEX_THREAD_ID, as its hooks name it", async () => {
    const { store, env } = await served();
    const thread = "01a0b45e-c62c-7ef0-8ee6-f70ef1d96430";
    const { id } = JSON.parse(
      await new Promise<string>((resolve, reject) =>
        execFile(
          process.execPath,
          [tsx, cli, "session", "create", "--title", "A"],
          { env: { ...env, CODEX_THREAD_ID: thread } },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        ),
      ),
    ) as { id: string };
    const [question] = store.addQuestions(id, [
      { type: "text", prompt: "Ship it?" },
    ]);
    store.answerQuestion(id, question!.id, { answer: "Yes" });
    const held = await hook(
      "stop",
      JSON.stringify({ session_id: thread }),
      env,
      ["--hold"],
    );
    expect(JSON.parse(held.stdout)).toMatchObject({ decision: "block" });
    expect(JSON.parse(held.stdout).reason).toContain(id);
  }, 60_000);

  it("links an interview kept in a variable, which the hook can't see, and waits on it", async () => {
    const { store, env } = await served();
    const agent = { ...env, CLAUDE_CODE_SESSION_ID: "claude-1" };
    const kim = (...args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(
          process.execPath,
          [tsx, cli, ...args],
          { env: agent },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        ),
      );
    const { id } = JSON.parse(await kim("session", "create", "--title", "A"));
    // `S=$(kim session create …)`: the tool's output has no id in it.
    await hook(
      "post-tool-use",
      JSON.stringify({
        session_id: "claude-1",
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "S=$(kim session create --title A)" },
        tool_response: { stdout: "" },
      }),
      env,
    );
    const [question] = store.addQuestions(id, [
      { type: "text", prompt: "Ship it?" },
    ]);
    const woken = hook("stop", JSON.stringify({ session_id: "claude-1" }), env);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    store.answerQuestion(id, question!.id, { answer: "Yes" });
    expect(await woken).toMatchObject({ code: 2 });

    // Stopped through a variable too: nothing keeps it linked.
    await kim("session", "stop", id, "--no-write");
    expect(
      await hook("stop", JSON.stringify({ session_id: "claude-1" }), env),
    ).toMatchObject({ code: 0, stderr: "" });
  }, 60_000);

  it("lets the agent stop once the interview is stopped", async () => {
    const { store, env } = await served();
    const session = store.createSession("", { title: "Plan" });
    store.addQuestions(session.id, [{ type: "text", prompt: "Ship it?" }]);
    await hook(
      "post-tool-use",
      JSON.stringify({
        session_id: "claude-1",
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: `kim wait ${session.id}` },
        tool_response: { stdout: "" },
      }),
      env,
    );
    const woken = hook("stop", JSON.stringify({ session_id: "claude-1" }), env);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    store.setSessionStatus(session.id, "stopped");
    expect(await woken).toMatchObject({ code: 0, stderr: "" });
  }, 30_000);

  it("prints {} and exits 0 on garbage, an unknown event, or a service that's down", async () => {
    const { env } = await served();
    for (const [event, stdin] of [
      ["post-tool-use", "not json"],
      ["nonsense", "{}"],
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

  it("are taken at most every 15 s between tool calls, and on every prompt", async () => {
    const { run, take } = setup();
    const start = Date.parse("2026-10-30T09:00:00Z");
    await run("PostToolUse", bash(`kim inbox show ${TOKEN}`), start);
    expect(take).toHaveBeenCalledTimes(1);
    await run("PostToolUse", bash("ls"), start + TAKE_THROTTLE_MS - 1);
    expect(take).toHaveBeenCalledTimes(1);
    await run(
      "UserPromptSubmit",
      { session_id: "s1", cwd: "/repo" },
      start + 1,
    );
    expect(take).toHaveBeenCalledTimes(2);
    await run("PostToolUse", bash("ls"), start + 1 + TAKE_THROTTLE_MS);
    expect(take).toHaveBeenCalledTimes(3);
  });

  it("don't count as the session's interview, so the Stop hook lets it stop", async () => {
    const { run, stateFile } = setup();
    await run("PostToolUse", bash(`kim inbox show ${TOKEN}`));
    const wait = vi.fn();
    expect(
      await runStop({ session_id: "s1" }, { stateFile, wait, waitMs: 1_000 }),
    ).toBeNull();
    expect(wait).not.toHaveBeenCalled();
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

describe("the Stop hook", () => {
  async function bound() {
    const { run, stateFile } = setup();
    await run(
      "PostToolUse",
      bash("kim session create --title A", JSON.stringify({ id: ID })),
    );
    return stateFile;
  }
  const stop = (
    stateFile: string,
    outcome: StopWaitOutcome,
    session = "s1",
  ) => {
    let time = 1_000;
    // The wait runs its course: the clock moves on by its length.
    const wait = vi.fn(async () => {
      time += 60_000;
      return outcome;
    });
    return {
      wait,
      result: runStop(
        { session_id: session },
        { stateFile, wait, waitMs: 60_000, now: 1_000, clock: () => time },
      ),
    };
  };

  it("lets a session with no interview stop, without asking the service", async () => {
    const stateFile = join(tempDir(), "hooks.json");
    const { wait, result } = stop(stateFile, null);
    expect(await result).toBeNull();
    expect(wait).not.toHaveBeenCalled();
  });

  it("waits on the session's interview and hands the user's answers back", async () => {
    const stateFile = await bound();
    const { wait, result } = stop(stateFile, {
      batch: batch([{ type: "answer.submitted" }]),
    });
    const text = (await result)?.text;
    expect(wait).toHaveBeenCalledWith(ID, 61_000, expect.any(AbortSignal));
    expect(text).toMatch(
      new RegExp(
        `^Keep it moving: answers to interview ${ID} arrived while you were waiting`,
      ),
    );
    expect(text).toContain('"answer":"Yes"');
  });

  it("says it's still waiting when only the agent's own edits came, or nothing did", async () => {
    const stateFile = await bound();
    for (const outcome of [
      { batch: batch([{ type: "question.added" }], { answers: [] }) },
      null,
    ]) {
      const text = (await stop(stateFile, outcome).result)?.text;
      expect(text).toContain("still running and nothing new has arrived");
      expect(text).toContain(`kim session stop ${ID}`);
    }
  });

  it("lets it stop, rather than wake the model, when the wait fails or ends early", async () => {
    const stateFile = await bound();
    for (const wait of [
      vi.fn(async () => {
        throw new Error("plan_limit");
      }),
      vi.fn(async (): Promise<StopWaitOutcome> => null),
    ])
      expect(
        await runStop(
          { session_id: "s1" },
          { stateFile, wait, waitMs: 60_000, clock: () => 0 },
        ),
      ).toBeNull();
    expect(readBindings(stateFile)).toHaveLength(1);
  });

  it("lets it stop once the interview ends, and forgets it; or when a newer waiter took over", async () => {
    let stateFile = await bound();
    expect(await stop(stateFile, "replaced").result).toBeNull();
    expect(readBindings(stateFile)).toHaveLength(1);
    expect(
      await stop(stateFile, { batch: batch([], { status: "stopped" }) }).result,
    ).toBeNull();
    expect(readBindings(stateFile)).toEqual([]);
    stateFile = await bound();
    expect(await stop(stateFile, "gone").result).toBeNull();
    expect(readBindings(stateFile)).toEqual([]);
  });

  it("waits on every interview the session is on, and wakes with the first answers and any that came with them", async () => {
    const { run, stateFile } = setup();
    for (const id of [ID, OTHER, THIRD])
      await run(
        "PostToolUse",
        bash("kim session create --title A", JSON.stringify({ id })),
      );
    const answered = batch([{ type: "answer.submitted" }]);
    const wait = vi.fn(
      (id: string, _deadline: number, signal: AbortSignal) =>
        new Promise<StopWaitOutcome>((resolve) => {
          if (id === ID) setTimeout(() => resolve({ batch: answered }), 10);
          // Arrives within the gathering time, so it comes along.
          else if (id === OTHER)
            setTimeout(() => resolve({ batch: answered }), 30);
          // Still waiting: cut short once the others answered.
          else
            signal.addEventListener("abort", () => resolve("replaced"), {
              once: true,
            });
        }),
    );
    const text = (
      await runStop(
        { session_id: "s1" },
        { stateFile, wait, waitMs: 60_000, gatherMs: 100 },
      )
    )?.text;
    expect(wait).toHaveBeenCalledTimes(3);
    expect(text).toContain(`answers to interview ${ID}`);
    expect(text).toContain(`answers to interview ${OTHER}`);
    expect(text).not.toContain(THIRD);
    expect(readBindings(stateFile)).toHaveLength(3);
  });

  it("keeps waiting on the rest when one interview ends, and names them all when nothing came", async () => {
    const { run, stateFile } = setup();
    for (const id of [ID, OTHER])
      await run(
        "PostToolUse",
        bash("kim session create --title A", JSON.stringify({ id })),
      );
    let time = 0;
    const wait = vi.fn(async (id: string): Promise<StopWaitOutcome> => {
      time = 60_000;
      return id === ID ? "gone" : null;
    });
    const text = (
      await runStop(
        { session_id: "s1" },
        { stateFile, wait, waitMs: 60_000, now: 0, clock: () => time },
      )
    )?.text;
    expect(text).toContain(`interview ${OTHER} is still running`);
    expect(readBindings(stateFile).map((b) => b.interviewId)).toEqual([OTHER]);
    // Two still waiting are both named.
    await run(
      "PostToolUse",
      bash("kim session create --title A", JSON.stringify({ id: THIRD })),
    );
    wait.mockImplementation(async () => {
      time += 60_000;
      return null;
    });
    const both = (
      await runStop(
        { session_id: "s1" },
        { stateFile, wait, waitMs: 60_000, now: 0, clock: () => time },
      )
    )?.text;
    expect(both).toContain(`interviews ${OTHER}, ${THIRD} are still running`);
  });

  it("only follows its own session's interview", async () => {
    const stateFile = await bound();
    const { wait, result } = stop(stateFile, null, "s2");
    expect(await result).toBeNull();
    expect(wait).not.toHaveBeenCalled();
  });

  it("keeps one waiter per session: a newer one, or the user's prompt, disarms the last", () => {
    const dir = tempDir();
    const first = armWaiter(dir, "s1");
    expect(waiterArmed(dir, "s1", first)).toBe(true);
    const second = armWaiter(dir, "s1");
    expect(waiterArmed(dir, "s1", first)).toBe(false);
    expect(waiterArmed(dir, "s1", second)).toBe(true);
    expect(waiterArmed(dir, "s2", second)).toBe(false);
    disarmWaiter(dir, "s1");
    expect(waiterArmed(dir, "s1", second)).toBe(false);
  });
});
