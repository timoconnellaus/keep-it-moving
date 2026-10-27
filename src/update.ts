import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Which CLI build this is, stamped by scripts/pack-cli.mjs; the site serves the latest as /cli-version.json. */
export interface CliBuild {
  version: string;
  build: string;
}

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 1_500;

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
 * At most once a day, asks the site for the latest CLI build and returns a
 * one-line hint when it differs from this one. A static file, so it never
 * reaches anyone's workspace. Gives up quickly, and never throws.
 */
export async function checkForUpdate(options: {
  base: string;
  current: CliBuild;
  stateFile: string;
  now?: number;
  fetch?: typeof globalThis.fetch;
}): Promise<string | null> {
  const now = options.now ?? Date.now();
  try {
    let checkedAt = 0;
    try {
      checkedAt =
        (
          JSON.parse(readFileSync(options.stateFile, "utf8")) as {
            checkedAt?: number;
          }
        ).checkedAt ?? 0;
    } catch {
      // Never checked.
    }
    if (now - checkedAt < UPDATE_CHECK_INTERVAL_MS) return null;
    // Stamp first, so a slow or failed check waits a day like any other.
    mkdirSync(dirname(options.stateFile), { recursive: true });
    writeFileSync(options.stateFile, `${JSON.stringify({ checkedAt: now })}\n`);
    const response = await (options.fetch ?? fetch)(
      `${options.base}/cli-version.json`,
      { signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const latest = (await response.json()) as Partial<CliBuild>;
    return latest.build && latest.build !== options.current.build
      ? "kim update available: run kim update"
      : null;
  } catch {
    return null;
  }
}
