import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Which CLI build this is, stamped by scripts/pack-cli.mjs; the site serves the latest as /cli-version.json. */
export interface CliBuild {
  version: string;
  build: string;
}

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 1_500;
export const UPDATE_HINT = "kim update available: run kim update";
/** A background update holding its lock longer than this has died. */
export const UPDATE_LOCK_STALE_MS = 10 * 60 * 1000;

export function readBuild(file: string): CliBuild | null {
  try {
    const stamp = JSON.parse(readFileSync(file, "utf8")) as Partial<CliBuild>;
    return stamp.build && stamp.version
      ? { version: stamp.version, build: stamp.build }
      : null;
  } catch {
    return null;
  }
}

/**
 * What the update checks remember: when the site was last asked, a hint
 * owed to the next command (from a check no one could print, or a failed
 * background update), and the build whose automatic install failed.
 */
export interface UpdateState {
  checkedAt?: number;
  hint?: boolean;
  failedBuild?: string;
}

export function readUpdateState(file: string): UpdateState {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

/** Merges `change` in; an undefined field is removed. */
export function writeUpdateState(
  file: string,
  change: { [K in keyof UpdateState]?: UpdateState[K] | undefined },
): void {
  const state = { ...readUpdateState(file), ...change };
  for (const key of Object.keys(state) as Array<keyof UpdateState>)
    if (state[key] === undefined) delete state[key];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state)}\n`);
}

export const updateDue = (stateFile: string, now = Date.now()) =>
  now - (readUpdateState(stateFile).checkedAt ?? 0) >= UPDATE_CHECK_INTERVAL_MS;

/**
 * At most every six hours, asks the site for the latest CLI build and
 * returns it when it differs from this one. A static file, so it never
 * reaches anyone's workspace. Gives up quickly, and never throws.
 */
export async function checkForUpdate(options: {
  base: string;
  current: CliBuild;
  stateFile: string;
  now?: number;
  fetch?: typeof globalThis.fetch;
  /** Ask now: whoever started this already stamped the check. */
  force?: boolean;
}): Promise<CliBuild | null> {
  const now = options.now ?? Date.now();
  try {
    if (!options.force && !updateDue(options.stateFile, now)) return null;
    // Stamp first, so a slow or failed check waits like any other.
    writeUpdateState(options.stateFile, { checkedAt: now });
    const response = await (options.fetch ?? fetch)(
      `${options.base}/cli-version.json`,
      { signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const latest = (await response.json()) as Partial<CliBuild>;
    return latest.build &&
      latest.version &&
      latest.build !== options.current.build
      ? { version: latest.version, build: latest.build }
      : null;
  } catch {
    return null;
  }
}

/**
 * Why kim mustn't update itself, or null when it may: the user opted out,
 * or this is a development link into a git checkout, which `npm install -g`
 * would replace.
 */
export function autoUpdateBlocked(
  packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.KEEP_IT_MOVING_NO_AUTO_UPDATE === "1")
    return "KEEP_IT_MOVING_NO_AUTO_UPDATE=1";
  try {
    for (let dir = realpathSync(packageRoot); ; dir = dirname(dir)) {
      if (existsSync(join(dir, ".git"))) return "a development link";
      if (dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
}

/** What to do about a newer build: nothing, say so, update, or leave the running update be. */
export type UpdateDecision = "none" | "hint" | "auto" | "running";

export function decideUpdate(options: {
  latest: CliBuild | null;
  blocked: string | null;
  state: UpdateState;
  locked: boolean;
}): UpdateDecision {
  const { latest, blocked, state, locked } = options;
  if (!latest) return "none";
  // One failed install of this build is enough; the user can run it themselves.
  if (blocked || state.failedBuild === latest.build) return "hint";
  return locked ? "running" : "auto";
}

/** Whether a live background update holds the lock. */
export function updateLocked(lockFile: string, now = Date.now()): boolean {
  try {
    return now - statSync(lockFile).mtimeMs < UPDATE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Takes the single-flight lock for a background update, replacing a stale
 * one; false when another update holds it.
 */
export function acquireUpdateLock(lockFile: string, now = Date.now()): boolean {
  mkdirSync(dirname(lockFile), { recursive: true });
  if (!updateLocked(lockFile, now)) rmSync(lockFile, { force: true });
  try {
    const fd = openSync(lockFile, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}
