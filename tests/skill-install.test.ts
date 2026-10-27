import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkbox } from "../src/checkbox.js";
import {
  canonicalSkill,
  installSkill,
  refreshSkill,
  rememberedAgents,
  type SkillPaths,
  uninstallSkill,
} from "../src/skill.js";
import { checkForUpdate, UPDATE_CHECK_INTERVAL_MS } from "../src/update.js";

const exec = promisify(execFile);
const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
  .pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const bundled = new URL("../skills/interviewer", import.meta.url).pathname;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A fresh HOME, so nothing touches the real ~/.claude. */
function tempHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kim-skill-test-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** A temp home and a copy of the bundled skill that a test can change. */
function setup(): SkillPaths {
  const home = tempHome();
  const source = join(home, "package", "skills", "interviewer");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "SKILL.md"),
    readFileSync(join(bundled, "SKILL.md")),
  );
  return { home, source, choiceFile: join(home, "config", "skill.json") };
}

const linkOf = (home: string, agent: string) =>
  join(home, agent, "skills", "interviewer");
const skillText = (dir: string) => readFileSync(join(dir, "SKILL.md"), "utf8");

describe("skill install", () => {
  it("copies the skill to ~/.agents and links it into the chosen agents only", () => {
    const paths = setup();
    const { home } = paths;
    const result = installSkill(paths, ["claude", "pi"]);
    const canonical = canonicalSkill(home);
    expect(result).toEqual({
      canonical,
      agents: ["claude", "pi"],
      linked: [linkOf(home, ".claude"), linkOf(home, ".pi/agent")],
      unlinked: [],
      skipped: [],
    });
    expect(lstatSync(canonical).isDirectory()).toBe(true);
    expect(skillText(canonical)).toBe(skillText(paths.source));
    for (const agent of [".claude", ".pi/agent"]) {
      expect(lstatSync(linkOf(home, agent)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkOf(home, agent))).toBe(canonical);
    }
    expect(existsSync(linkOf(home, ".codex"))).toBe(false);
    expect(rememberedAgents(paths.choiceFile)).toEqual(["claude", "pi"]);
  });

  it("drops its own link from an agent no longer chosen", () => {
    const paths = setup();
    installSkill(paths, ["claude", "codex"]);
    const result = installSkill(paths, ["claude"]);
    expect(result.unlinked).toEqual([linkOf(paths.home, ".codex")]);
    expect(existsSync(linkOf(paths.home, ".codex"))).toBe(false);
    expect(rememberedAgents(paths.choiceFile)).toEqual(["claude"]);
  });

  it("refuses to replace a link or folder it didn't make, unless forced", () => {
    const paths = setup();
    const { home } = paths;
    // A dev checkout's link, as scripts/link-skill.mjs makes, and a hand-made folder.
    const checkout = join(home, "repo", "skills", "interviewer");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "SKILL.md"), "dev copy");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(checkout, linkOf(home, ".claude"), "dir");
    mkdirSync(linkOf(home, ".codex"), { recursive: true });
    writeFileSync(join(linkOf(home, ".codex"), "SKILL.md"), "hand made");

    const refused = installSkill(paths, ["claude", "codex"]);
    expect(refused.linked).toEqual([]);
    expect(refused.skipped).toEqual([
      {
        path: linkOf(home, ".claude"),
        reason: expect.stringContaining("a symlink") as string,
      },
      {
        path: linkOf(home, ".codex"),
        reason: expect.stringContaining("--force") as string,
      },
    ]);
    expect(readlinkSync(linkOf(home, ".claude"))).toBe(checkout);
    expect(skillText(linkOf(home, ".codex"))).toBe("hand made");

    const forced = installSkill(paths, ["claude", "codex"], true);
    expect(forced.skipped).toEqual([]);
    expect(readlinkSync(linkOf(home, ".claude"))).toBe(canonicalSkill(home));
    expect(readlinkSync(linkOf(home, ".codex"))).toBe(canonicalSkill(home));
    // Replacing the link left what it pointed to alone.
    expect(skillText(checkout)).toBe("dev copy");
  });

  it("won't replace a canonical folder it didn't make, and links nothing then", () => {
    const paths = setup();
    const canonical = canonicalSkill(paths.home);
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "someone else's");
    const result = installSkill(paths, ["claude"]);
    expect(result.skipped).toEqual([
      { path: canonical, reason: expect.stringContaining("--force") as string },
    ]);
    expect(result.linked).toEqual([]);
    expect(skillText(canonical)).toBe("someone else's");
    expect(existsSync(linkOf(paths.home, ".claude"))).toBe(false);
  });

  it("refreshes its copy when the bundled skill changes, and only then", () => {
    const paths = setup();
    installSkill(paths, ["claude"]);
    expect(refreshSkill(paths)).toBe(false);
    writeFileSync(join(paths.source, "SKILL.md"), "a newer skill");
    expect(refreshSkill(paths)).toBe(true);
    // The agent sees it through its link.
    expect(skillText(linkOf(paths.home, ".claude"))).toBe("a newer skill");
    expect(refreshSkill(paths)).toBe(false);
  });

  it("never refreshes a copy it didn't make", () => {
    const paths = setup();
    const canonical = canonicalSkill(paths.home);
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "someone else's");
    expect(refreshSkill(paths)).toBe(false);
    expect(skillText(canonical)).toBe("someone else's");
  });

  it("uninstalls only its own links and copy", () => {
    const paths = setup();
    const { home } = paths;
    installSkill(paths, ["claude"]);
    mkdirSync(linkOf(home, ".codex"), { recursive: true });
    writeFileSync(join(linkOf(home, ".codex"), "SKILL.md"), "hand made");
    expect(uninstallSkill(paths)).toEqual({
      removed: [linkOf(home, ".claude"), canonicalSkill(home)],
    });
    expect(existsSync(linkOf(home, ".claude"))).toBe(false);
    expect(existsSync(canonicalSkill(home))).toBe(false);
    expect(skillText(linkOf(home, ".codex"))).toBe("hand made");
    expect(rememberedAgents(paths.choiceFile)).toBeNull();
  });
});

describe("kim skill install", () => {
  const kim = async (home: string, ...args: string[]) => {
    const { stdout, stderr } = await exec(
      process.execPath,
      [tsx, cli, ...args],
      { env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    return { result: JSON.parse(stdout) as Record<string, unknown>, stderr };
  };

  it("installs for Claude Code only without a terminal or flags, then remembers --agents", async () => {
    const home = tempHome();
    const first = await kim(home, "skill", "install");
    expect(first.result.agents).toEqual(["claude"]);
    expect(first.stderr).toContain("--agents");
    expect(readlinkSync(linkOf(home, ".claude"))).toBe(canonicalSkill(home));
    expect(skillText(canonicalSkill(home))).toBe(skillText(bundled));

    await kim(home, "skill", "install", "--agents", "claude,codex");
    const again = await kim(home, "skill", "install");
    expect(again.result.agents).toEqual(["claude", "codex"]);
    expect(again.stderr).toBe("");

    const removed = await kim(home, "skill", "uninstall");
    expect(removed.result.removed).toEqual([
      linkOf(home, ".claude"),
      linkOf(home, ".codex"),
      canonicalSkill(home),
    ]);
  }, 30_000);
});

describe("the agent checklist", () => {
  it("toggles with space, moves with arrows and confirms with enter", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    const chosen = checkbox(
      "Which?",
      [
        { value: "claude", label: "Claude Code", checked: true },
        { value: "codex", label: "Codex", checked: false },
        { value: "pi", label: "Pi", checked: true },
      ],
      input,
      output,
    );
    // Down to Codex and tick it, down to Pi and untick it.
    input.write("\x1b[B");
    input.write(" ");
    input.write("\x1b[B");
    input.write(" ");
    input.write("\r");
    expect(await chosen).toEqual(["claude", "codex"]);
  });

  it("cancels with Ctrl-C", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    const chosen = checkbox(
      "Which?",
      [{ value: "claude", label: "Claude Code", checked: true }],
      input,
      output,
    );
    input.write("\x03");
    expect(await chosen).toBeNull();
  });
});

describe("the update check", () => {
  const current = { version: "0.1.0", build: "aaaaaaaaaaaa" };
  const server = (build: string) =>
    vi.fn(async () => Response.json({ version: "0.1.0", build }));

  it("hints when the site has another build, at most once a day", async () => {
    const stateFile = join(tempHome(), "update-check.json");
    const fetch = server("bbbbbbbbbbbb");
    const start = Date.parse("2026-10-27T09:00:00Z");
    const check = (now: number) =>
      checkForUpdate({
        base: "https://kim.test",
        current,
        stateFile,
        now,
        fetch,
      });
    expect(await check(start)).toBe("kim update available: run kim update");
    expect(fetch).toHaveBeenCalledWith(
      "https://kim.test/cli-version.json",
      expect.anything(),
    );
    expect(await check(start + UPDATE_CHECK_INTERVAL_MS - 1)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await check(start + UPDATE_CHECK_INTERVAL_MS)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when current, and swallows a failing server", async () => {
    const stateFile = join(tempHome(), "update-check.json");
    expect(
      await checkForUpdate({
        base: "https://kim.test",
        current,
        stateFile,
        fetch: server(current.build),
      }),
    ).toBeNull();
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(
      await checkForUpdate({
        base: "https://kim.test",
        current,
        stateFile: join(tempHome(), "update-check.json"),
        fetch: failing,
      }),
    ).toBeNull();
    // A failed check still waits a day.
    expect(
      await checkForUpdate({
        base: "https://kim.test",
        current,
        stateFile,
        now: Date.now() + 1_000,
        fetch: failing,
      }),
    ).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
