import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  hookEntry,
  hooksStatus,
  installHooks,
  uninstallHooks,
} from "../src/hooks.js";
import { homeEnv } from "./helpers/home.js";

const exec = promisify(execFile);
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A fresh HOME, so nothing touches the real ~/.claude or ~/.codex. */
function tempHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kim-hooks-test-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** No CLAUDE_CONFIG_DIR or CODEX_HOME unless a test sets one. */
const bare: NodeJS.ProcessEnv = {};

const theirs = {
  matcher: "Edit|Write",
  hooks: [{ type: "command", command: "npx prettier --write", timeout: 30 }],
};

describe("installing the hooks into Claude Code's settings.json", () => {
  it("adds one entry per event beside everything else, keeping the file's indent", () => {
    const home = tempHome();
    const file = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"));
    const before = {
      model: "opus",
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PostToolUse: [theirs] },
    };
    writeFileSync(file, `${JSON.stringify(before, null, 4)}\n`);
    const result = installHooks("claude", home, bare);
    expect(result).toMatchObject({
      file,
      changed: true,
      events: ["SessionStart", "UserPromptSubmit", "PostToolUse"],
    });
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^\{\n {4}"model"/);
    expect(JSON.parse(text)).toEqual({
      model: "opus",
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        PostToolUse: [
          theirs,
          {
            hooks: [
              {
                type: "command",
                command: "kim hook post-tool-use",
                timeout: 5,
              },
            ],
          },
        ],
        SessionStart: [hookEntry("SessionStart")],
        UserPromptSubmit: [hookEntry("UserPromptSubmit")],
      },
    });
    // Again: nothing changes, not even the bytes.
    expect(installHooks("claude", home, bare).changed).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("uninstalls only its own entries, even from a group someone added to", () => {
    const home = tempHome();
    const file = join(home, ".claude", "settings.json");
    installHooks("claude", home, bare);
    const settings = JSON.parse(readFileSync(file, "utf8"));
    settings.hooks.SessionStart[0].hooks.push({
      type: "command",
      command: "echo hi",
    });
    settings.hooks.PostToolUse.unshift(theirs);
    writeFileSync(file, JSON.stringify(settings, null, 2));
    expect(uninstallHooks("claude", home, bare).changed).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        PostToolUse: [theirs],
      },
    });
    expect(hooksStatus("claude", home, bare).events).toEqual([]);
    expect(uninstallHooks("claude", home, bare).changed).toBe(false);
  });

  it("drops the hooks key it made, and leaves no file it didn't need", () => {
    const home = tempHome();
    const file = join(home, ".claude", "settings.json");
    writeFileSync(
      (mkdirSync(join(home, ".claude")), file),
      '{\n  "model": "opus"\n}\n',
    );
    installHooks("claude", home, bare);
    uninstallHooks("claude", home, bare);
    expect(readFileSync(file, "utf8")).toBe('{\n  "model": "opus"\n}\n');
    expect(uninstallHooks("codex", home, bare).changed).toBe(false);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("follows CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    const home = tempHome();
    const env = {
      CLAUDE_CONFIG_DIR: join(home, "profile"),
      CODEX_HOME: join(home, "codex"),
    };
    expect(installHooks("claude", home, env).file).toBe(
      join(home, "profile", "settings.json"),
    );
    expect(installHooks("codex", home, env).file).toBe(
      join(home, "codex", "hooks.json"),
    );
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(home, "codex", "hooks.json"), "utf8")).hooks
        .UserPromptSubmit,
    ).toEqual([hookEntry("UserPromptSubmit")]);
  });

  it("refuses a settings file it can't read as JSON, and leaves it alone", () => {
    const home = tempHome();
    const file = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"));
    writeFileSync(file, "{ // a comment\n}");
    expect(() => installHooks("claude", home, bare)).toThrow(/valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{ // a comment\n}");
    expect(hooksStatus("claude", home, bare).error).toMatch(/valid JSON/);
  });
});

describe("kim hooks and kim skill install", () => {
  const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
    .pathname;
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const kim = async (home: string, ...args: string[]) =>
    JSON.parse(
      (
        await exec(process.execPath, [tsx, cli, ...args], {
          env: homeEnv(home),
        })
      ).stdout,
    );

  it("installs for the agents found here, and reports status", async () => {
    const home = tempHome();
    mkdirSync(join(home, ".codex"));
    const installed = await kim(home, "hooks", "install");
    expect(
      installed.hooks.map((hook: { agent: string }) => hook.agent),
    ).toEqual(["codex"]);
    const status = await kim(home, "hooks", "status");
    expect(status.hooks).toEqual([
      expect.objectContaining({ agent: "claude", events: [] }),
      expect.objectContaining({
        agent: "codex",
        events: ["SessionStart", "UserPromptSubmit", "PostToolUse"],
      }),
    ]);
    await kim(home, "hooks", "uninstall");
    expect(
      JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")),
    ).toEqual({});
  }, 30_000);

  it("skill install adds the hooks for Claude Code and Codex unless --no-hooks", async () => {
    const home = tempHome();
    const result = await kim(
      home,
      "skill",
      "install",
      "--agents",
      "claude,cursor",
    );
    expect(result.hooks).toEqual([
      expect.objectContaining({ agent: "claude", changed: true }),
    ]);
    expect(hooksStatus("claude", home, bare).events).toHaveLength(3);
    const other = tempHome();
    const without = await kim(
      other,
      "skill",
      "install",
      "--agents",
      "claude",
      "--no-hooks",
    );
    expect(without.hooks).toEqual([]);
    expect(existsSync(join(other, ".claude", "settings.json"))).toBe(false);
  }, 30_000);
});
