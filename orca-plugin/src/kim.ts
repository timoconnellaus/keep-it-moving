/**
 * Runs the user's `kim` (and `orca`) the way their terminal would: through
 * their login shell, so the PATH that finds them (nvm, Homebrew, npm's
 * global bin) is the one they set up. The plugin never talks to the
 * network itself; kim does, with its own sign-in.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { KimProblem } from "./protocol";

export interface Runner {
  /** The command, or a path to it; empty means `kim` on the PATH. */
  kimCommand(): Promise<string>;
}

const shell = () =>
  process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");

/** Spawns `command args…` in a login shell, never interpolating args. */
export function spawnInShell(command: string, args: string[]): ChildProcess {
  return spawn(shell(), ["-lc", 'exec "$0" "$@"', command, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export class KimError extends Error {
  constructor(readonly problem: KimProblem) {
    super(problem.kind === "failed" ? problem.message : problem.kind);
  }
}

/** What a failed run means: kim missing, signed out, or its own error. */
export function problemFrom(
  code: number | null,
  stdout: string,
  stderr: string,
): KimProblem {
  const text = `${stdout}\n${stderr}`;
  if (
    code === 127 ||
    /command not found|No such file or directory|not found: kim/i.test(stderr)
  )
    return { kind: "missing" };
  if (/Not signed in|kim login/i.test(text)) return { kind: "signed-out" };
  for (const line of text.split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as { error?: string };
      if (parsed.error) return { kind: "failed", message: parsed.error };
    } catch {
      // Not JSON: keep looking.
    }
  }
  return {
    kind: "failed",
    message: stderr.trim().split("\n").pop() || `kim exited ${code}`,
  };
}

/** Runs kim once and parses the JSON it prints. */
export async function runKim<T>(
  runner: Runner,
  args: string[],
  timeoutMs = 60_000,
): Promise<T> {
  const command = (await runner.kimCommand()) || "kim";
  return new Promise<T>((resolve, reject) => {
    const child = spawnInShell(command, args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", () => reject(new KimError({ kind: "missing" })));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout) as T);
        } catch {
          reject(
            new KimError({
              kind: "failed",
              message: "kim printed something that isn't JSON",
            }),
          );
        }
      } else reject(new KimError(problemFrom(code, stdout, stderr)));
    });
  });
}

/**
 * Keeps `kim overview --watch` running, calling `onOverview` for each
 * line and `onProblem` when it can't run; restarts it after a pause when
 * it stops. Returns a function that stops it for good.
 */
export function watchOverview(
  runner: Runner,
  onOverview: (value: unknown) => void,
  onProblem: (problem: KimProblem) => void,
): () => void {
  let stopped = false;
  let child: ChildProcess | null = null;
  let delay = 2_000;
  const start = async () => {
    if (stopped) return;
    const command = (await runner.kimCommand()) || "kim";
    child = spawnInShell(command, [
      "overview",
      "--watch",
      "--interval",
      "4000",
    ]);
    let buffer = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as { error?: string };
          if (value.error) onProblem(problemFrom(1, line, ""));
          else {
            delay = 2_000;
            onOverview(value);
          }
        } catch {
          // A stray line: ignore it.
        }
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("close", (code) => {
      child = null;
      if (stopped) return;
      onProblem(problemFrom(code, "", stderr));
      setTimeout(() => void start(), delay);
      delay = Math.min(delay * 2, 60_000);
    });
  };
  void start();
  return () => {
    stopped = true;
    child?.kill();
  };
}

/** Runs `orca tab create` to open a URL in Orca's browser, in that workspace. */
export function openInOrca(
  url: string,
  workspacePath: string | null,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawnInShell("orca", [
      "tab",
      "create",
      "--url",
      url,
      ...(workspacePath ? ["--worktree", `path:${workspacePath}`] : []),
      "--json",
    ]);
    let stdout = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk));
    child.on("error", () => resolve(false));
    child.on("close", (code) =>
      resolve(code === 0 && /"ok"\s*:\s*true/.test(stdout)),
    );
  });
}
