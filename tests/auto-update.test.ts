import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireUpdateLock,
  autoUpdateBlocked,
  decideUpdate,
  readUpdateState,
  UPDATE_LOCK_STALE_MS,
  updateLocked,
  writeUpdateState,
} from "../src/update.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kim-update-test-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const latest = { version: "0.1.0", build: "bbbbbbbbbbbb" };

describe("whether kim may update itself", () => {
  it("may, from a global npm install", () => {
    const root = join(
      tempDir(),
      "lib",
      "node_modules",
      "@tim",
      "keep-it-moving",
    );
    mkdirSync(root, { recursive: true });
    expect(autoUpdateBlocked(root, {})).toBeNull();
  });

  it("mayn't from a development link into a git checkout", () => {
    const dir = tempDir();
    const repo = join(dir, "repos", "interviewer");
    mkdirSync(join(repo, ".git"), { recursive: true });
    // As `npm link` leaves it: the global package is a symlink to the repo.
    const modules = join(dir, "lib", "node_modules", "@tim");
    mkdirSync(modules, { recursive: true });
    symlinkSync(repo, join(modules, "keep-it-moving"));
    expect(autoUpdateBlocked(join(modules, "keep-it-moving"), {})).toBe(
      "a development link",
    );
    // A worktree's .git is a file.
    const worktree = join(dir, "worktree");
    mkdirSync(join(worktree, "dist"), { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n");
    expect(autoUpdateBlocked(worktree, {})).toBe("a development link");
  });

  it("mayn't when the user opts out", () => {
    expect(
      autoUpdateBlocked(tempDir(), { KEEP_IT_MOVING_NO_AUTO_UPDATE: "1" }),
    ).toBe("KEEP_IT_MOVING_NO_AUTO_UPDATE=1");
  });
});

describe("what to do about a newer build", () => {
  const decide = (change: Partial<Parameters<typeof decideUpdate>[0]> = {}) =>
    decideUpdate({
      latest,
      blocked: null,
      state: {},
      locked: false,
      ...change,
    });

  it("updates in the background, unless one already is", () => {
    expect(decide()).toBe("auto");
    expect(decide({ locked: true })).toBe("running");
    expect(decide({ latest: null })).toBe("none");
  });

  it("only hints where it mayn't update, or after that build failed to install", () => {
    expect(decide({ blocked: "a development link" })).toBe("hint");
    expect(decide({ state: { failedBuild: latest.build } })).toBe("hint");
    // A newer build after the failed one gets its own try.
    expect(decide({ state: { failedBuild: "aaaaaaaaaaaa" } })).toBe("auto");
  });
});

describe("the background update's lock", () => {
  it("lets one update run at a time, and outlives a dead one only so long", () => {
    const lock = join(tempDir(), "config", "update.lock");
    expect(updateLocked(lock)).toBe(false);
    expect(acquireUpdateLock(lock)).toBe(true);
    expect(updateLocked(lock)).toBe(true);
    expect(acquireUpdateLock(lock)).toBe(false);
    const old = (Date.now() - UPDATE_LOCK_STALE_MS - 1_000) / 1000;
    utimesSync(lock, old, old);
    expect(updateLocked(lock)).toBe(false);
    expect(acquireUpdateLock(lock)).toBe(true);
  });
});

describe("the update state", () => {
  it("merges changes, and an undefined field removes it", () => {
    const file = join(tempDir(), "update-check.json");
    writeUpdateState(file, { checkedAt: 1, hint: true, failedBuild: "b" });
    writeUpdateState(file, { hint: undefined });
    expect(readUpdateState(file)).toEqual({ checkedAt: 1, failedBuild: "b" });
  });
});
