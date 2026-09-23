import { readFileSync } from "node:fs";
import { join } from "node:path";
import envPaths from "env-paths";

/** Where `interviewer config gemini-key` stores the key, readable only by its owner. */
export function geminiKeyFile(): string {
  return join(envPaths("interviewer").config, "gemini-api-key");
}

/**
 * The Gemini key from the daemon's environment, else the key file. Read on
 * each use, so storing a key needs no restart, and whichever agent happened
 * to start the daemon doesn't decide whether voice works.
 */
export function geminiApiKey(
  file = geminiKeyFile(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}
