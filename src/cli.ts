#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import envPaths from "env-paths";
import { geminiKeyFile } from "./server/config.js";

const defaultBase = process.env.INTERVIEWER_URL ?? "http://127.0.0.1:47831";

async function main(args: string[]): Promise<void> {
  if (!args.length || args.includes("--help") || args[0] === "help")
    return printHelp();
  const [group, action, ...rest] = args;
  // These manage the daemon itself, so they must not start it first.
  if (group === "daemon") return daemonCommand(action);
  if (group === "config") return configCommand(action, rest);
  await ensureDaemon();
  if (group === "session") return sessionCommand(action, rest);
  if (group === "question") return questionCommand(action, rest);
  if (group === "clarification") return clarificationCommand(action, rest);
  if (group === "artifact") return artifactCommand(action, rest);
  if (group === "plan")
    return planCommand(
      [action, ...rest].filter((value): value is string => Boolean(value)),
    );
  if (group === "note")
    return noteCommand(
      [action, ...rest].filter((value): value is string => Boolean(value)),
    );
  if (group === "attach")
    return attach(
      [action, ...rest].filter((value): value is string => Boolean(value)),
    );
  if (group === "events" && action === "next") return eventsNext(rest);
  if (group === "wait")
    return waitForBatch(
      [action, ...rest].filter((value): value is string => Boolean(value)),
    );
  throw new Error(`Unknown command: ${args.join(" ")}`);
}

async function sessionCommand(action: string | undefined, args: string[]) {
  if (action === "create")
    return output(
      await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          title: flag(args, "--title") ?? "Untitled interview",
        }),
      }),
    );
  if (action === "list")
    return output(
      await api(`/api/sessions${args.includes("--all") ? "?all=true" : ""}`),
    );
  const id = positional(args, 0);
  if (action === "show") return output(await api(`/api/sessions/${id}`));
  if (action === "stop" || action === "resume")
    return output(
      await api(`/api/sessions/${id}/${action}`, { method: "POST" }),
    );
  if (action === "delete")
    return output(await api(`/api/sessions/${id}`, { method: "DELETE" }));
  throw new Error(`Unknown session action: ${action ?? ""}`);
}

async function questionCommand(action: string | undefined, args: string[]) {
  const sessionId = positional(args, 0);
  if (action === "add") {
    const supplied = await jsonInput(args);
    const input = supplied ?? questionFromFlags(args);
    return output(
      await api(`/api/sessions/${sessionId}/questions`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  }
  const questionId = positional(args, 1);
  if (action === "update") {
    const input = (await jsonInput(args)) ?? questionFromFlags(args);
    return output(
      await api(`/api/sessions/${sessionId}/questions/${questionId}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    );
  }
  if (action === "delete")
    return output(
      await api(`/api/sessions/${sessionId}/questions/${questionId}`, {
        method: "DELETE",
      }),
    );
  if (action === "focus")
    return output(
      await api(`/api/sessions/${sessionId}/focus`, {
        method: "POST",
        body: JSON.stringify({
          questionId: questionId === "none" ? null : questionId,
        }),
      }),
    );
  if (action === "reorder") {
    const position = Number(flag(args, "--position"));
    return output(
      await api(`/api/sessions/${sessionId}/questions/${questionId}`, {
        method: "PATCH",
        body: JSON.stringify({ position }),
      }),
    );
  }
  throw new Error(`Unknown question action: ${action ?? ""}`);
}

/** Content from --file (a path, or - for stdin) or --content. */
async function artifactContent(args: string[]): Promise<string | undefined> {
  const file = flag(args, "--file");
  if (file === "-") {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return text;
  }
  if (file) return readFileSync(file, "utf8");
  return flag(args, "--content");
}

const KIND_BY_EXTENSION: Record<string, string> = {
  md: "document",
  markdown: "document",
  svg: "diagram",
  html: "mockup",
  htm: "mockup",
};

const ARCHIFY_TYPES = new Set([
  "architecture",
  "workflow",
  "sequence",
  "dataflow",
  "lifecycle",
]);

/** An archify diagram spec, recognized by its diagram_type. */
function archifySpec(
  content: string,
): { diagram_type: string; meta?: { title?: string } } | null {
  try {
    const spec = JSON.parse(content) as { diagram_type?: unknown };
    return typeof spec?.diagram_type === "string" &&
      ARCHIFY_TYPES.has(spec.diagram_type)
      ? (spec as { diagram_type: string })
      : null;
  } catch {
    return null;
  }
}

/** The archify skill's CLI; INTERVIEWER_ARCHIFY overrides the usual install locations. */
function findArchify(): string {
  const candidates = [
    process.env.INTERVIEWER_ARCHIFY,
    ...[".agents", ".claude", ".codex"].map((dir) =>
      join(homedir(), dir, "skills", "archify", "bin", "archify.mjs"),
    ),
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found)
    throw new Error(
      "Diagram specs are rendered with the archify skill, which wasn't found. Install it, or set INTERVIEWER_ARCHIFY to its bin/archify.mjs.",
    );
  return found;
}

function runArchify(archify: string, args: string[]): string {
  try {
    return execFileSync(process.execPath, [archify, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    if (failed.stdout?.trim()) return failed.stdout;
    throw new Error(
      `archify ${args[0]} failed: ${failed.stderr ?? String(error)}`,
    );
  }
}

/**
 * Validates and renders an archify spec to its standalone HTML viewer. A
 * failed validation reports archify's diagnostics, with supported fixes.
 */
function renderArchify(
  content: string,
  file: string | undefined,
  quality: string | undefined,
): string {
  const spec = archifySpec(content)!;
  const archify = findArchify();
  const dir = mkdtempSync(join(tmpdir(), "interviewer-archify-"));
  try {
    // Validate the original file when there is one, so relative references resolve.
    const input =
      file && file !== "-"
        ? file
        : join(dir, `diagram.${spec.diagram_type}.json`);
    if (input !== file) writeFileSync(input, content);
    const qualityArgs = quality ? ["--quality", quality] : [];
    const report = JSON.parse(
      runArchify(archify, [
        "validate",
        spec.diagram_type,
        input,
        "--json",
        ...qualityArgs,
      ]),
    ) as { ok: boolean; error?: string; diagnostics?: unknown };
    if (!report.ok)
      throw new Error(
        `archify validation failed; fix the spec and retry:\n${JSON.stringify(
          { error: report.error, diagnostics: report.diagnostics },
          null,
          2,
        )}`,
      );
    const output = join(dir, "diagram.html");
    runArchify(archify, [
      "render",
      spec.diagram_type,
      input,
      output,
      ...qualityArgs,
    ]);
    return readFileSync(output, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Artifact fields from a file or --content; archify specs arrive rendered, with their source. */
async function artifactInput(args: string[]): Promise<{
  content?: string;
  source?: string;
  kind?: string;
  title?: string | undefined;
}> {
  const content = await artifactContent(args);
  if (content === undefined) return {};
  const spec = archifySpec(content);
  if (!spec) return { content };
  return {
    content: renderArchify(
      content,
      flag(args, "--file"),
      flag(args, "--quality"),
    ),
    source: content,
    kind: "diagram",
    title: spec.meta?.title,
  };
}

function artifactFields(
  args: string[],
  input: { content?: string; source?: string },
) {
  const fields: Record<string, unknown> = {};
  const title = flag(args, "--title");
  if (title) fields.title = title;
  if (input.content !== undefined) fields.content = input.content;
  if (input.source !== undefined) fields.source = input.source;
  const description = flag(args, "--description");
  if (description !== undefined) fields.description = description;
  if (args.includes("--show")) fields.show = true;
  return fields;
}

async function artifactCommand(action: string | undefined, args: string[]) {
  const sessionId = positional(args, 0);
  if (action === "add") {
    const input = await artifactInput(args);
    if (input.content === undefined)
      throw new Error("--file <path|-> or --content is required");
    const file = flag(args, "--file");
    const kind =
      flag(args, "--kind") ??
      input.kind ??
      KIND_BY_EXTENSION[file?.split(".").pop()?.toLowerCase() ?? ""];
    if (!kind)
      throw new Error(
        "--kind is required (document, diagram, mockup); archify specs are detected",
      );
    const fields = artifactFields(args, input);
    fields.title ??= input.title ?? file?.split("/").pop() ?? "Untitled";
    return output(
      await api(`/api/sessions/${sessionId}/artifacts`, {
        method: "POST",
        body: JSON.stringify({ kind, ...fields }),
      }),
    );
  }
  const artifactId = positional(args, 1);
  if (action === "update")
    return output(
      await api(`/api/sessions/${sessionId}/artifacts/${artifactId}`, {
        method: "PATCH",
        body: JSON.stringify(artifactFields(args, await artifactInput(args))),
      }),
    );
  if (action === "show")
    return output(
      await api(`/api/sessions/${sessionId}/stage`, {
        method: "POST",
        body: JSON.stringify({
          artifactId: artifactId === "none" ? null : artifactId,
        }),
      }),
    );
  if (action === "delete")
    return output(
      await api(`/api/sessions/${sessionId}/artifacts/${artifactId}`, {
        method: "DELETE",
      }),
    );
  throw new Error(`Unknown artifact action: ${action ?? ""}`);
}

/** Creates or replaces the session's single plan document. */
async function planCommand(args: string[]) {
  const sessionId = positional(args, 0);
  const content = await artifactContent(args);
  if (content === undefined)
    throw new Error("--file <path|-> or --content is required");
  const fields = artifactFields(args, { content });
  fields.title ??= "Plan";
  return output(
    await api(`/api/sessions/${sessionId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({ kind: "plan", ...fields }),
    }),
  );
}

async function noteCommand(args: string[]) {
  const sessionId = positional(args, 0);
  const text = flag(args, "--text");
  if (!text) throw new Error("--text is required");
  return output(
    await api(`/api/sessions/${sessionId}/notes`, {
      method: "POST",
      body: JSON.stringify({
        text,
        questionId: flag(args, "--question") ?? null,
        speak: args.includes("--speak"),
      }),
    }),
  );
}

async function clarificationCommand(
  action: string | undefined,
  args: string[],
) {
  if (action !== "reply")
    throw new Error(`Unknown clarification action: ${action ?? ""}`);
  const sessionId = positional(args, 0);
  const requestId = positional(args, 1);
  const response =
    flag(args, "--text") ??
    String(
      ((await jsonInput(args)) as { response?: string } | null)?.response ?? "",
    );
  if (!response) throw new Error("--text or JSON response is required");
  return output(
    await api(`/api/sessions/${sessionId}/clarifications/${requestId}/reply`, {
      method: "POST",
      body: JSON.stringify({ response }),
    }),
  );
}

async function attach(args: string[]) {
  const id = positional(args, 0);
  const response = await fetch(`${defaultBase}/api/sessions/${id}/attach`);
  if (!response.ok) throw new Error(await errorMessage(response));
  if (!response.body) throw new Error("Attach stream unavailable");
  process.stdout.on("error", () => process.exit(0));
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(value);
  }
}

async function eventsNext(args: string[]) {
  const id = positional(args, 0);
  const timeout = flag(args, "--timeout") ?? "25000";
  output(
    await api(
      `/api/sessions/${id}/events/next?timeout=${encodeURIComponent(timeout)}`,
    ),
  );
}

interface DaemonInfo {
  pid: number;
  version: string;
  startedAt: string;
  geminiKey: boolean;
}

async function daemonInfo(): Promise<DaemonInfo | null> {
  try {
    const response = await fetch(`${defaultBase}/api/daemon`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok ? ((await response.json()) as DaemonInfo) : null;
  } catch {
    return null;
  }
}

async function healthy(): Promise<boolean> {
  try {
    return (
      await fetch(`${defaultBase}/health`, {
        signal: AbortSignal.timeout(300),
      })
    ).ok;
  } catch {
    return false;
  }
}

/** The daemon's pid, falling back to its runtime file for builds without /api/daemon. */
async function daemonPid(): Promise<number | null> {
  const info = await daemonInfo();
  if (info) return info.pid;
  if (!(await healthy())) return null;
  try {
    const runtime = JSON.parse(
      readFileSync(join(envPaths("interviewer").temp, "daemon.json"), "utf8"),
    ) as { pid?: number };
    return runtime.pid ?? null;
  } catch {
    return null;
  }
}

async function stopDaemon(): Promise<boolean> {
  const pid = await daemonPid();
  if (!pid) return false;
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt++) {
    await delay(100);
    if (!(await healthy())) return true;
  }
  throw new Error(`Daemon ${pid} did not stop`);
}

/** Restart after a rebuild so the daemon runs the new code. */
async function daemonCommand(action: string | undefined) {
  if (action === "status") {
    const info = await daemonInfo();
    return output(info ? { running: true, ...info } : { running: false });
  }
  if (action === "stop") return output({ stopped: await stopDaemon() });
  if (action === "restart") {
    await stopDaemon();
    await ensureDaemon();
    return output({ running: true, ...(await daemonInfo()) });
  }
  throw new Error(`Unknown daemon action: ${action ?? ""}`);
}

/** Reads a secret without echoing it at a terminal, or from piped stdin. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    return text.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new Error("Cancelled"));
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function configCommand(action: string | undefined, args: string[]) {
  if (action !== "gemini-key")
    throw new Error(`Unknown config setting: ${action ?? ""}`);
  const file = geminiKeyFile();
  if (args.includes("--clear")) {
    rmSync(file, { force: true });
    return output({ ok: true, cleared: file });
  }
  const key = await readSecret("Gemini API key (input hidden): ");
  if (!key) throw new Error("No key entered");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  // The daemon reads the file on each voice start; no restart needed.
  return output({ ok: true, file });
}

/** Node's fetch abandons responses after ~5 minutes, so long waits are chained. */
const WAIT_REQUEST_MS = 240_000;

async function waitForBatch(args: string[]) {
  const id = positional(args, 0);
  const idle = flag(args, "--idle") ?? "15000";
  const deadline = Date.now() + Number(flag(args, "--timeout") ?? 600_000);
  for (;;) {
    const timeout = Math.max(
      0,
      Math.min(WAIT_REQUEST_MS, deadline - Date.now()),
    );
    const batch = (await api(
      `/api/sessions/${id}/wait?idle=${encodeURIComponent(idle)}&timeout=${timeout}`,
    )) as { events: unknown[] };
    if (batch.events.length || Date.now() >= deadline) return output(batch);
  }
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const request = init?.body
    ? { ...init, headers: { "content-type": "application/json" } }
    : init;
  const response = await fetch(`${defaultBase}${path}`, request);
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}
async function errorMessage(response: Response): Promise<string> {
  const value = (await response
    .json()
    .catch(() => ({ error: response.statusText }))) as { error?: string };
  return value.error ?? `HTTP ${response.status}`;
}

async function ensureDaemon(): Promise<void> {
  try {
    if (
      (
        await fetch(`${defaultBase}/health`, {
          signal: AbortSignal.timeout(300),
        })
      ).ok
    )
      return;
  } catch {
    /* start it */
  }
  if (process.env.INTERVIEWER_URL)
    throw new Error(`Interviewer service is unavailable at ${defaultBase}`);
  const here = dirname(fileURLToPath(import.meta.url));
  const server = join(here, "server", "main.js");
  if (!existsSync(server))
    throw new Error("Built daemon not found. Run npm run build first.");
  const child = spawn(process.execPath, [server], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(100);
    try {
      if (
        (
          await fetch(`${defaultBase}/health`, {
            signal: AbortSignal.timeout(300),
          })
        ).ok
      )
        return;
    } catch {
      /* retry */
    }
  }
  throw new Error("Interviewer daemon did not start");
}

async function jsonInput(args: string[]): Promise<unknown | null> {
  const inline = flag(args, "--json");
  if (inline && inline !== "-") return JSON.parse(inline);
  if (inline === "-" || args.includes("--stdin")) {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return JSON.parse(text);
  }
  return null;
}
function questionFromFlags(args: string[]): Record<string, unknown> {
  const prompt = flag(args, "--prompt");
  if (!prompt) throw new Error("--prompt or --json is required");
  const result: Record<string, unknown> = {
    prompt,
    type: flag(args, "--type") ?? "text",
  };
  const recommendation = flag(args, "--recommendation");
  if (recommendation) result.recommendation = recommendation;
  const options = flags(args, "--option");
  if (options.length) result.options = options;
  const artifact = flag(args, "--artifact");
  if (artifact) result.artifactId = artifact;
  const defaults = flags(args, "--default");
  if (defaults.length)
    result.default = defaults.length === 1 ? defaults[0] : defaults;
  for (const key of ["min", "max", "step", "position"]) {
    const value = flag(args, `--${key}`);
    if (value !== undefined) result[key] = Number(value);
  }
  return result;
}
/** Flags that take no value, so the next argument stays positional. */
const BOOLEAN_FLAGS = new Set(["--all", "--show", "--speak", "--stdin"]);

function positional(args: string[], index: number): string {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]?.startsWith("--")) {
      if (!BOOLEAN_FLAGS.has(args[i]!)) i++;
      continue;
    }
    values.push(args[i]!);
  }
  const value = values[index];
  if (!value) throw new Error(`Missing positional argument ${index + 1}`);
  return value;
}
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((arg, index) => {
    if (arg === name && args[index + 1]) out.push(args[index + 1]!);
  });
  return out;
}
function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function printHelp(): void {
  process.stdout.write(
    `interviewer — local agent-driven interviews\n\nCommands:\n  session create --title <text>\n  session list [--all]|show <id>|stop <id>|resume <id>|delete <id>\n  question add <session> --prompt <text> [--type <type>] [--option <text>] [--default <text>] [--recommendation <text>] [--artifact <id>]\n  types: text, single-choice, multiple-choice, yes-no, number; repeat --option/--default\n  question add|update <session> [question] --json '<object>'  (use --json - for stdin)\n  question delete|focus|reorder <session> <question> [--position N]\n  wait <session> [--idle MS] [--timeout MS]   one batch of answers once the user pauses\n  attach <session>\n  events next <session> [--timeout MS]\n  clarification reply <session> <request> --text <response>\n  note <session> --text <text> [--question <id>] [--speak]   message voice; --speak relays it right away\n  daemon status|restart|stop   restart after a rebuild to run the new code\n  config gemini-key [--clear]   store the key voice uses (typed hidden, or piped)\n  plan <session> --file <path|-> | --content <md> [--show]   create or replace the plan document\n  artifact add <session> --file <path|-> [--kind document|diagram|mockup] [--title T] [--description D] [--show]\n    diagrams: an archify spec (.json with diagram_type) is validated and rendered; also archify HTML or SVG\n  artifact update <session> <artifact> [--file|--content] [--title] [--description] [--show] [--quality showcase]\n  artifact show <session> <artifact|none>   put it on screen\n  artifact delete <session> <artifact>\n`,
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});
