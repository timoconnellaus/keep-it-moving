#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import envPaths from "env-paths";
import { parseDuration } from "./shared/automations.js";
import { normalizeRemote } from "./shared/remote.js";

const defaultBase = (
  process.env.INTERVIEWER_URL ?? "https://interviewer.zerobsai.com"
).replace(/\/+$/, "");

async function main(args: string[]): Promise<void> {
  if (!args.length || args.includes("--help") || args[0] === "help")
    return printHelp();
  const [group, action, ...rest] = args;
  if (group === "login") return login();
  if (group === "logout") return logout();
  if (group === "whoami") return whoami();
  if (group === "session") return sessionCommand(action, rest);
  if (group === "question") return questionCommand(action, rest);
  if (group === "artifact") return artifactCommand(action, rest);
  if (group === "stage") return stageCommand(action, rest);
  if (group === "project") return projectCommand(action, rest);
  if (group === "heartbeat" || group === "automation")
    return automationsCommand(group, action, rest);
  if (group === "pr") return prCommand(action, rest);
  if (group === "backlog") return backlogCommand(action, rest);
  if (group === "plan")
    return planCommand(
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
  if (action === "create") {
    const session = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: flag(args, "--title") ?? "Untitled interview",
        stageVisible: args.includes("--open-stage"),
        origin: detectOrigin(args),
      }),
    });
    return output(session);
  }
  if (action === "list")
    return output(
      await api(`/api/sessions${args.includes("--all") ? "?all=true" : ""}`),
    );
  const id = positional(args, 0);
  if (action === "show") return output(await api(`/api/sessions/${id}`));
  if (action === "stop" || action === "resume") {
    const result = await api(`/api/sessions/${id}/${action}`, {
      method: "POST",
    });
    return output(result);
  }
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

function git(...args: string[]): string | null {
  try {
    return (
      execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** "claude-code_2-1-286_agent" → "Claude Code", from the shared AI_AGENT convention. */
function agentName(): string | undefined {
  const raw = process.env.AI_AGENT?.split("_")[0];
  if (raw)
    return raw
      .split("-")
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join(" ");
  if (process.env.CLAUDECODE) return "Claude Code";
  return undefined;
}

/**
 * Where this interview runs. The project is the git remote, so every
 * worktree and cloud session of a repo lands in one project; without a
 * remote it is the main checkout's folder. --project names one explicitly.
 */
function detectOrigin(args: string[]): Record<string, string> {
  const origin: Record<string, string> = {};
  const set = (key: string, value: string | null | undefined) => {
    if (value) origin[key] = value;
  };
  const remote = git("remote", "get-url", "origin");
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (remote) set("projectKey", normalizeRemote(remote));
  else if (common)
    set("projectKey", `local/${basename(dirname(common)).toLowerCase()}`);
  set("project", flag(args, "--project"));
  set("branch", git("rev-parse", "--abbrev-ref", "HEAD"));
  const top = git("rev-parse", "--show-toplevel");
  if (top) set("worktree", basename(top));
  set("agent", flag(args, "--agent") ?? agentName());
  set("agentSession", flag(args, "--agent-session"));
  set("agentSessionId", process.env.CLAUDE_CODE_SESSION_ID);
  const location =
    flag(args, "--location") ??
    (process.env.CLAUDE_CODE_REMOTE === "true" ? "cloud" : undefined);
  set("location", location ?? (process.env.CLAUDECODE ? "local" : undefined));
  return origin;
}

async function projectCommand(action: string | undefined, args: string[]) {
  if (action === "list") return output(await api("/api/sessions/projects"));
  if (action === "rename" || action === "color") {
    const value = flag(args, action === "rename" ? "--name" : "--color");
    if (!value)
      throw new Error(
        action === "rename" ? "--name is required" : "--color is required",
      );
    return output(
      await api("/api/sessions/projects/update", {
        method: "POST",
        body: JSON.stringify({
          project: positional(args, 0),
          [action === "rename" ? "name" : "color"]: value,
        }),
      }),
    );
  }
  throw new Error(`Unknown project action: ${action ?? ""}`);
}

/**
 * Pull requests the server synced from GitHub. The project defaults to this
 * repo's normalised remote, as `session create` detects it.
 */
async function prCommand(action: string | undefined, args: string[]) {
  if (action !== "list") throw new Error(`Unknown pr action: ${action ?? ""}`);
  const project = flag(args, "--project") ?? detectOrigin([]).projectKey;
  if (!project)
    throw new Error("No git remote here; pass --project <key or name>");
  return output(
    await api(`/api/sessions/kim/prs?project=${encodeURIComponent(project)}`),
  );
}

// Backlog, milestones and follow-ups ---------------------------------------

/** --project, else this repo's project key, normalised as detectOrigin does. */
function backlogProject(args: string[]): string {
  const named = flag(args, "--project");
  if (named) return named;
  const remote = git("remote", "get-url", "origin");
  if (remote) return normalizeRemote(remote);
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common) return `local/${basename(dirname(common)).toLowerCase()}`;
  throw new Error("Not in a git repository; pass --project <key>");
}

/** A sync script gets this long to print the backlog. */
const SYNC_SCRIPT_TIMEOUT_MS = 60_000;

async function backlogCommand(action: string | undefined, args: string[]) {
  const project = backlogProject(args);
  const settings = (patch: Record<string, unknown>) =>
    api("/api/sessions/kim/backlog/settings", {
      method: "POST",
      body: JSON.stringify({ project, ...patch }),
    });
  if (action === "show")
    return output(
      await api(
        `/api/sessions/kim/backlog?project=${encodeURIComponent(project)}`,
      ),
    );
  if (action === "sync")
    return output(await backlogSync(project, args.includes("--trust")));
  if (action === "next") return output(await backlogNext(project, args));
  if (action === "source") {
    const source = positional(args, 0);
    if (!["github", "script", "none"].includes(source))
      throw new Error("backlog source takes github, script or none");
    return output(await settings({ source }));
  }
  if (action === "script" && positional(args, 0) === "set") {
    const script = await artifactContent(args);
    if (!script) throw new Error("--file <path|-> is required");
    // Saved from here, so this machine already trusts it.
    trustScript(script);
    return output(await settings({ script, source: "script" }));
  }
  if (action === "milestone" && positional(args, 0) === "set") {
    const milestone = positional(args, 1);
    return output(
      await settings({ milestone: milestone === "auto" ? null : milestone }),
    );
  }
  if (action === "milestone" && positional(args, 0) === "add")
    return output(
      await api("/api/sessions/kim/backlog/milestones", {
        method: "POST",
        body: JSON.stringify({
          project,
          name: positional(args, 1),
          due: flag(args, "--due"),
        }),
      }),
    );
  if (action === "auto-write") {
    const value = positional(args, 0);
    if (value !== "on" && value !== "off")
      throw new Error("backlog auto-write takes on or off");
    return output(await settings({ autoWrite: value === "on" }));
  }
  throw new Error(`Unknown backlog action: ${action ?? ""}`);
}

/**
 * Syncs the project's backlog. GitHub syncs on the server; a script source
 * comes back as the script, which runs here (with this machine's
 * environment and credentials) and its JSON goes up to the server.
 */
async function backlogSync(project: string, trust = false): Promise<unknown> {
  const result = (await api("/api/sessions/kim/backlog/sync", {
    method: "POST",
    body: JSON.stringify({ project }),
  })) as { script?: string };
  if (typeof result.script !== "string") return result;
  // The script comes from the server: run only one this machine approved, so
  // a stolen CLI token can't run code everywhere an agent syncs.
  if (!isTrustedScript(result.script)) {
    if (!trust)
      throw new Error(
        `This machine hasn't approved ${project}'s sync script (sha256 ${scriptHash(result.script).slice(0, 12)}). ` +
          `Read it with \`interviewer backlog show --project ${project}\`, then run \`interviewer backlog sync --project ${project} --trust\`.`,
      );
    trustScript(result.script);
  }
  const fail = async (message: string) => {
    await api("/api/sessions/kim/backlog/error", {
      method: "POST",
      body: JSON.stringify({ project, error: message }),
    }).catch(() => undefined);
    throw new Error(message);
  };
  const dir = mkdtempSync(join(tmpdir(), "interviewer-sync-"));
  const file = join(dir, "sync.mjs");
  writeFileSync(file, result.script);
  let run;
  try {
    run = spawnSync(process.execPath, [file], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: SYNC_SCRIPT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const stderr = run.stderr?.trim().slice(-4000) ?? "";
  if (run.error || run.status !== 0) {
    const why =
      run.signal === "SIGTERM"
        ? `timed out after ${SYNC_SCRIPT_TIMEOUT_MS / 1000}s`
        : run.error
          ? `failed to run: ${run.error.message}`
          : `exited with ${run.status}`;
    return fail(`The sync script ${why}${stderr ? `:\n${stderr}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return fail(
      `The sync script's output isn't JSON: ${run.stdout.trim().slice(0, 200)}${stderr ? `\n${stderr}` : ""}`,
    );
  }
  return api("/api/sessions/kim/backlog/items", {
    method: "POST",
    body: JSON.stringify({ project, output: parsed }),
  });
}

/** Before an agent picks up work: sync, then the top open items in order. */
/** Sync scripts this machine approved, by SHA-256 of their text. */
const trustedScriptsFile = () =>
  join(envPaths("interviewer").config, "trusted-sync-scripts.json");

const scriptHash = (script: string) =>
  createHash("sha256").update(script).digest("hex");

function trustedScripts(): string[] {
  try {
    const hashes: unknown = JSON.parse(
      readFileSync(trustedScriptsFile(), "utf8"),
    );
    return Array.isArray(hashes) ? hashes.map(String) : [];
  } catch {
    return [];
  }
}

const isTrustedScript = (script: string) =>
  trustedScripts().includes(scriptHash(script));

function trustScript(script: string): void {
  const hashes = new Set(trustedScripts()).add(scriptHash(script));
  const file = trustedScriptsFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify([...hashes], null, 2), { mode: 0o600 });
}

async function backlogNext(project: string, args: string[]) {
  let syncError: string | undefined;
  try {
    await backlogSync(project, args.includes("--trust"));
  } catch (error) {
    // The last good sync is still worth showing.
    syncError = error instanceof Error ? error.message : String(error);
  }
  const backlog = (await api(
    `/api/sessions/kim/backlog?project=${encodeURIComponent(project)}`,
  )) as {
    milestone: unknown;
    settings: { syncedAt: string | null };
    items: { status: string }[];
  };
  return {
    project,
    milestone: backlog.milestone,
    syncedAt: backlog.settings.syncedAt,
    ...(syncError ? { syncError } : {}),
    items: backlog.items
      .filter((item) => item.status === "in_progress" || item.status === "todo")
      .slice(0, Number(flag(args, "--limit") ?? 5)),
  };
}

/** Opens or closes the workspace column beside the questions. */
async function stageCommand(action: string | undefined, args: string[]) {
  if (action !== "open" && action !== "close")
    throw new Error(`Unknown stage action: ${action ?? ""}`);
  return output(
    await api(`/api/sessions/${positional(args, 0)}/stage/visibility`, {
      method: "POST",
      body: JSON.stringify({ visible: action === "open" }),
    }),
  );
}

async function attach(args: string[]) {
  const id = positional(args, 0);
  const response = await authorizedFetch(`/api/sessions/${id}/attach`);
  if (!response.ok) throw new Error(await errorMessage(response));
  if (!response.body) throw new Error("Attach stream unavailable");
  process.stdout.on("error", () => process.exit(0));
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines)
      // Heartbeats only keep the connection open through proxies.
      if (line && !line.startsWith('{"type":"heartbeat"'))
        process.stdout.write(`${line}\n`);
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

/**
 * Cloudflare drops a response that sends nothing for 100 s, so a long wait
 * is a chain of shorter requests. Each but the last asks for a partial
 * result, which leaves events queued rather than ending the batch early.
 */
const WAIT_REQUEST_MS = 60_000;

async function waitForBatch(args: string[]) {
  const id = positional(args, 0);
  const idle = flag(args, "--idle") ?? "15000";
  const deadline = Date.now() + Number(flag(args, "--timeout") ?? 600_000);
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now());
    const last = remaining <= WAIT_REQUEST_MS;
    const batch = (await api(
      `/api/sessions/${id}/wait?idle=${encodeURIComponent(idle)}&timeout=${Math.min(remaining, WAIT_REQUEST_MS)}${last ? "" : "&partial=1"}`,
    )) as { partial?: boolean };
    if (!batch.partial) return output(batch);
  }
}

/** This repo's project key, normalised the same way as detectOrigin's. */
function currentProjectKey(): string | undefined {
  const remote = git("remote", "get-url", "origin");
  if (remote) return normalizeRemote(remote);
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  return common
    ? `local/${basename(dirname(common)).toLowerCase()}`
    : undefined;
}

/** A heartbeat gives up rather than hold up the loop that sends it. */
const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * `heartbeat <name>` registers an automation and checks in, and beats this
 * machine too; a loop runs it once per iteration. With --quiet it never
 * fails the caller: no output, exit 0. `automation list|remove` manage them.
 */
async function automationsCommand(
  group: string,
  action: string | undefined,
  rest: string[],
) {
  if (group === "heartbeat") {
    const args = [action, ...rest].filter(
      (value): value is string => value !== undefined && value !== "--quiet",
    );
    const quiet = rest.includes("--quiet") || action === "--quiet";
    try {
      const project = flag(args, "--project") ?? currentProjectKey();
      if (!project)
        throw new Error("Not in a git repo; pass --project <key> to heartbeat");
      const result = await api("/api/sessions/kim/heartbeat", {
        method: "POST",
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
        body: JSON.stringify({
          project,
          name: positional(args, 0),
          every: parseDuration(flag(args, "--every") ?? "5m"),
          command: flag(args, "--command"),
          status: flag(args, "--status"),
          machine: hostname(),
          platform: process.platform,
        }),
      });
      if (!quiet) output(result);
    } catch (error) {
      if (!quiet) throw error;
    }
    return;
  }
  if (action === "list") {
    // --project, else this repo's project unless --all.
    const project =
      flag(rest, "--project") ??
      (rest.includes("--all") ? undefined : currentProjectKey());
    return output(
      await api(
        `/api/sessions/kim/automations${project ? `?project=${encodeURIComponent(project)}` : ""}`,
      ),
    );
  }
  if (action === "remove")
    return output(
      await api(
        `/api/sessions/kim/automations/${encodeURIComponent(positional(rest, 0))}`,
        { method: "DELETE" },
      ),
    );
  throw new Error(`Unknown automation action: ${action ?? ""}`);
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await authorizedFetch(path, init);
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}
async function errorMessage(response: Response): Promise<string> {
  if (response.status === 401)
    return "Not signed in. Run `interviewer login` in a terminal.";
  const value = (await response
    .json()
    .catch(() => ({ error: response.statusText }))) as { error?: string };
  return value.error ?? `HTTP ${response.status}`;
}

/** A request with the stored access token, refreshed when it is about to expire or is refused. */
async function authorizedFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const send = (token: string | null) =>
    fetch(`${defaultBase}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers as Record<string, string> | undefined),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  const response = await send(await accessToken(false));
  if (response.status !== 401) return response;
  const refreshed = await accessToken(true);
  return refreshed ? send(refreshed) : response;
}

interface Credentials {
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

const credentialsFile = () =>
  join(envPaths("interviewer").config, "credentials.json");

/** Sign-ins by service URL, so a local Worker and the deployed one can coexist. */
function readCredentials(): Record<string, Credentials> {
  try {
    return JSON.parse(readFileSync(credentialsFile(), "utf8")) as Record<
      string,
      Credentials
    >;
  } catch {
    return {};
  }
}

function writeCredentials(credentials: Credentials | null): void {
  const all = readCredentials();
  if (credentials) all[defaultBase] = credentials;
  else delete all[defaultBase];
  const file = credentialsFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function accessToken(forceRefresh: boolean): Promise<string | null> {
  if (process.env.INTERVIEWER_TOKEN) return process.env.INTERVIEWER_TOKEN;
  const stored = readCredentials()[defaultBase];
  if (!stored) return null;
  if (!forceRefresh && stored.expiresAt - Date.now() > 60_000)
    return stored.accessToken;
  if (!stored.refreshToken) return null;
  const response = await fetch(`${defaultBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
      client_id: stored.clientId,
    }),
  });
  if (!response.ok) return null;
  const tokens = (await response.json()) as TokenResponse;
  writeCredentials(credentialsFrom(stored.clientId, tokens, stored));
  return tokens.access_token;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

function credentialsFrom(
  clientId: string,
  tokens: TokenResponse,
  previous?: Credentials,
): Credentials {
  return {
    clientId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

/**
 * Signs in through the browser: the Worker's Cloudflare Access login, then
 * OAuth (authorization code with PKCE) back to a one-off loopback callback.
 */
async function login() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  let finish!: (result: { code?: string; error?: string }) => void;
  const result = new Promise<{ code?: string; error?: string }>((resolve) => {
    finish = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const ok = url.searchParams.get("state") === state && code !== null;
    response
      .writeHead(ok ? 200 : 400, { "content-type": "text/html" })
      .end(
        `<!doctype html><meta charset="utf-8"><p style="font:16px system-ui;margin:3rem">${ok ? "Signed in. You can close this tab." : "Sign-in failed. Check the terminal."}</p>`,
      );
    finish(
      ok
        ? { code }
        : {
            error:
              url.searchParams.get("error_description") ??
              url.searchParams.get("error") ??
              "State mismatch",
          },
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const registration = await fetch(`${defaultBase}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "interviewer CLI",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (!registration.ok)
      throw new Error(
        `Client registration failed: ${await registration.text()}`,
      );
    const { client_id: clientId } = (await registration.json()) as {
      client_id: string;
    };
    const authorizeUrl = new URL(`${defaultBase}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "interviews",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    process.stderr.write(
      `Opening your browser to sign in. If it doesn't open, visit:\n${authorizeUrl}\n`,
    );
    openBrowser(authorizeUrl.toString());
    const timeout = setTimeout(
      () => finish({ error: "Timed out waiting for sign-in" }),
      300_000,
    );
    const { code, error } = await result;
    clearTimeout(timeout);
    if (!code) throw new Error(error ?? "Sign-in failed");
    const response = await fetch(`${defaultBase}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    if (!response.ok)
      throw new Error(`Token exchange failed: ${await response.text()}`);
    writeCredentials(
      credentialsFrom(clientId, (await response.json()) as TokenResponse),
    );
    return output({ ok: true, url: defaultBase });
  } finally {
    server.close();
  }
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the URL is printed */
  }
}

async function logout() {
  writeCredentials(null);
  return output({ ok: true, url: defaultBase });
}

async function whoami() {
  const stored = readCredentials()[defaultBase];
  const signedIn = (await authorizedFetch("/api/sessions")).ok;
  return output({
    url: defaultBase,
    signedIn,
    ...(stored
      ? { tokenExpiresAt: new Date(stored.expiresAt).toISOString() }
      : {}),
  });
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
const BOOLEAN_FLAGS = new Set(["--all", "--show", "--stdin", "--open-stage"]);

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
    `interviewer — agent-driven interviews (${defaultBase})

Commands:
  login | logout | whoami   sign in through the browser (Cloudflare Access, then OAuth)
  session create --title <text> [--open-stage] [--agent-session <your session title>] [--project <name>]
    the workspace column starts closed unless --open-stage; the project comes from the git remote
  project list | rename <project> --name <name> | color <project> --color <#hex>
  pr list [--project <key>]   open PRs with CI and readiness; defaults to this repo's remote
  session list [--all]|show <id>|stop <id>|resume <id>|delete <id>
  question add <session> --prompt <text> [--type <type>] [--option <text>] [--default <text>] [--recommendation <text>] [--artifact <id>]
  types: text, single-choice, multiple-choice, yes-no, number; repeat --option/--default
  question add|update <session> [question] --json '<object>'  (use --json - for stdin)
  question delete|focus|reorder <session> <question> [--position N]
  wait <session> [--idle MS] [--timeout MS]   one batch of answers once the user pauses
  attach <session>
  events next <session> [--timeout MS]
  plan <session> --file <path|-> | --content <md> [--show]   create or replace the plan document
  artifact add <session> --file <path|-> [--kind document|diagram|mockup] [--title T] [--description D] [--show]
    diagrams: an archify spec (.json with diagram_type) is validated and rendered; also archify HTML or SVG
  artifact update <session> <artifact> [--file|--content] [--title] [--description] [--show] [--quality showcase]
  artifact show <session> <artifact|none>   choose what the workspace shows
  artifact delete <session> <artifact>
  stage open|close <session>   show or hide the workspace column

Keep it moving:
  heartbeat <name> [--every 5m] [--project <key>] [--command "/loop /babysitter"] [--status <text>] [--quiet]
    register an automation and check in (run once per loop iteration); it's down after 2 missed
    check-ins. The project defaults to this repo; --quiet never fails the caller
  automation list [--project <key>] [--all]   this repo's automations by default
  automation remove <id>
Backlog (the project defaults to this repo's; --project <key> picks another):
  backlog show | sync | next [--limit 5]   next syncs first, then prints the top open items
  backlog source github|script|none
  backlog script set --file <path|->   save the project's sync script; it runs here on sync
  backlog milestone set <name|sourceId|auto> | milestone add <name> [--due YYYY-MM-DD]
  backlog auto-write on|off   accept follow-ups into the source as they arrive

INTERVIEWER_URL points at another deployment, such as wrangler dev.
`,
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});
