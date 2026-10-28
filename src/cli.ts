#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import envPaths from "env-paths";
import { checkbox } from "./checkbox.js";
import { normalizeRemote, projectName } from "./shared/remote.js";
import {
  type AgentId,
  canonicalSkill,
  installedAgents,
  installSkill,
  parseAgents,
  refreshSkill,
  rememberedAgents,
  SKILL_AGENTS,
  type SkillPaths,
  uninstallSkill,
} from "./skill.js";
import { checkForUpdate, readBuild } from "./update.js";

/**
 * KEEP_IT_MOVING_<name>, else the older INTERVIEWER_<name>, so environments
 * set up before the rename keep working.
 */
const setting = (name: string): string | undefined =>
  process.env[`KEEP_IT_MOVING_${name}`] || process.env[`INTERVIEWER_${name}`];

const defaultBase = (
  setting("URL") ?? "https://keep-it-moving.zerobsai.com"
).replace(/\/+$/, "");

async function main(args: string[]): Promise<void> {
  housekeeping(args[0]);
  if (!args.length || args.includes("--help") || args[0] === "help")
    return printHelp();
  const [group, action, ...rest] = args;
  if (group === "update") return update();
  if (group === "login") return login();
  if (group === "logout") return logout();
  if (group === "whoami") return whoami();
  if (group === "session") return sessionCommand(action, rest);
  if (group === "question") return questionCommand(action, rest);
  if (group === "artifact") return artifactCommand(action, rest);
  if (group === "stage") return stageCommand(action, rest);
  if (group === "chat") return chatCommand(action, rest);
  if (group === "project") return projectCommand(action);
  if (group === "key") return keyCommand(action, rest);
  if (group === "cloud") return cloudCommand(action, rest);
  if (group === "skill") return skillCommand(action, rest);
  if (group === "ask")
    return ask(
      [action, ...rest].filter((value): value is string => Boolean(value)),
    );
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
    const assignee = flag(args, "--assign");
    if (!assignee) return output(session);
    const { id } = session as { id: string };
    return output({
      ...(session as object),
      ...((await assign(id, assignee)) as object),
    });
  }
  if (action === "list")
    return output(
      await api(`/api/sessions${args.includes("--all") ? "?all=true" : ""}`),
    );
  if (action === "delete") return deleteSessions(args);
  const id = positional(args, 0);
  if (action === "show") return output(await api(`/api/sessions/${id}`));
  if (action === "stop" || action === "resume") {
    const result = await api(`/api/sessions/${id}/${action}`, {
      method: "POST",
    });
    return output(result);
  }
  if (action === "assign") {
    const email = args.includes("--clear") ? null : positional(args, 1);
    return output(await assign(id, email));
  }
  throw new Error(`Unknown session action: ${action ?? ""}`);
}

/**
 * Deletes each interview named, or with --stopped every stopped one, and
 * prints what went. One that fails doesn't stop the rest; it is listed
 * under `failed` and the command exits 1.
 */
async function deleteSessions(args: string[]) {
  const ids = args.includes("--stopped")
    ? (
        (await api("/api/sessions?all=true")) as Array<{
          id: string;
          status: string;
        }>
      )
        .filter((session) => session.status === "stopped")
        .map((session) => session.id)
    : args.length
      ? args
      : [positional(args, 0)];
  const deleted: Array<{ id: string; title: string; assignee: string | null }> =
    [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids)
    try {
      // The Worker forgets an assigned interview's share as it goes.
      const { title, assignee } = (await api(`/api/sessions/${id}`, {
        method: "DELETE",
      })) as { title: string; assignee: string | null };
      deleted.push({ id, title, assignee });
    } catch (error) {
      failed.push({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  output(failed.length ? { deleted, failed } : { deleted });
  if (failed.length) process.exitCode = 1;
}

/**
 * Hands an interview to someone else to answer, or takes it back with null.
 * They sign in with Google as that email at the returned URL.
 */
const assign = (id: string, email: string | null) =>
  api(`/api/sessions/${id}/assign`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });

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

/** The archify skill's CLI; KEEP_IT_MOVING_ARCHIFY overrides the usual install locations. */
function findArchify(): string {
  const candidates = [
    setting("ARCHIFY"),
    ...[".agents", ".claude", ".codex"].map((dir) =>
      join(homedir(), dir, "skills", "archify", "bin", "archify.mjs"),
    ),
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found)
    throw new Error(
      "Diagram specs are rendered with the archify skill, which wasn't found. Install it, or set KEEP_IT_MOVING_ARCHIFY to its bin/archify.mjs.",
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
  const dir = mkdtempSync(join(tmpdir(), "kim-archify-"));
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

/** Runs git in a directory (default: this process's), or returns null. */
function git(cwd: string | undefined, ...args: string[]): string | null {
  try {
    return (
      execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        ...(cwd ? { cwd } : {}),
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * The repo a directory belongs to: its project key (the normalised remote,
 * or the main checkout's folder without one), branch and worktree.
 */
function repoOrigin(cwd?: string): Record<string, string> {
  const origin: Record<string, string> = {};
  const remote = git(cwd, "remote", "get-url", "origin");
  const common = git(
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  if (remote) origin.projectKey = normalizeRemote(remote);
  else if (common)
    origin.projectKey = `local/${basename(dirname(common)).toLowerCase()}`;
  const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  if (branch) origin.branch = branch;
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (top) origin.worktree = basename(top);
  return origin;
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
  const repo = repoOrigin();
  set("projectKey", repo.projectKey);
  set("project", flag(args, "--project"));
  set("branch", repo.branch);
  set("worktree", repo.worktree);
  set("agent", flag(args, "--agent") ?? agentName());
  set("agentSession", flag(args, "--agent-session"));
  const location =
    flag(args, "--location") ??
    (process.env.CLAUDE_CODE_REMOTE === "true" ? "cloud" : undefined);
  set("location", location ?? (process.env.CLAUDECODE ? "local" : undefined));
  return origin;
}

async function projectCommand(action: string | undefined) {
  if (action === "list") return output(await api("/api/sessions/projects"));
  throw new Error(`Unknown project action: ${action ?? ""}`);
}

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

/**
 * `chat list <session>` prints the interview's chat; `chat reply <session>
 * --text "…" | --file <path|-> [--to <message>]` answers the user in it.
 */
async function chatCommand(action: string | undefined, args: string[]) {
  const sessionId = positional(args, 0);
  if (action === "list")
    return output(await api(`/api/sessions/${sessionId}/chat`));
  if (action !== "reply")
    throw new Error(`Unknown chat action: ${action ?? ""}`);
  const file = flag(args, "--file");
  let text = flag(args, "--text");
  if (file === "-") {
    text = "";
    for await (const chunk of process.stdin) text += chunk;
  } else if (file) text = readFileSync(file, "utf8");
  if (!text?.trim())
    throw new Error('--text "…" or --file <path|-> is required');
  const replyTo = flag(args, "--to");
  return output(
    await api(`/api/sessions/${sessionId}/chat`, {
      method: "POST",
      body: JSON.stringify({ text, ...(replyTo ? { replyTo } : {}) }),
    }),
  );
}

async function attach(args: string[]) {
  const id = positional(args, 0);
  process.stdout.on("error", () => process.exit(0));
  await watchInterview(
    id,
    () => ({ mode: "attach" }),
    (message, line) => {
      process.stdout.write(`${line}\n`);
      // The interview ends this watch; a newer watcher took over.
      return message.type === "replaced" ? "done" : undefined;
    },
  );
}

async function eventsNext(args: string[]) {
  const id = positional(args, 0);
  const timeout = flag(args, "--timeout") ?? "25000";
  let result: unknown;
  await watchInterview(
    id,
    () => ({ mode: "next", timeout }),
    (message) => {
      if (message.type !== "next") return;
      result = message.result;
      return "done";
    },
  );
  output(result);
}

async function waitForBatch(args: string[]) {
  output(await nextBatch(positional(args, 0), args));
}

/** One batch of answers for an interview. */
async function nextBatch(id: string, args: string[]): Promise<unknown> {
  const idle = flag(args, "--idle") ?? "15000";
  const deadline = Date.now() + Number(flag(args, "--timeout") ?? 600_000);
  let batch: unknown;
  await watchInterview(
    id,
    // A reconnect asks only for what is left of the wait.
    () => ({
      mode: "wait",
      idle,
      timeout: String(Math.max(0, deadline - Date.now())),
    }),
    (message) => {
      if (message.type !== "batch") return;
      batch = message.batch;
      return "done";
    },
  );
  return batch;
}

/** How often the CLI pings an idle socket, so proxies keep it open. */
const PING_MS = 30_000;
/** A socket that hears nothing, not even a pong, for this long is gone. */
const SILENT_MS = 75_000;
const RECONNECT_MAX_MS = 30_000;

interface WatchMessage {
  type: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * Watches an interview over a WebSocket, which costs the server nothing
 * while the user is away; the HTTP long-polls older CLIs use kept it busy.
 * `onMessage` returns "done" once it has what it came for. A dropped
 * connection reconnects with backoff, asking `query` again; a refusal
 * (signed out, deleted, not allowed) or a newer watcher ends it with an error.
 */
async function watchInterview(
  id: string,
  query: () => Record<string, string>,
  onMessage: (message: WatchMessage, line: string) => "done" | undefined,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken();
    const ended = await new Promise<"done" | "dropped" | Error>((resolve) => {
      const url = `${defaultBase.replace(/^http/, "ws")}/api/sessions/${encodeURIComponent(id)}/socket?${new URLSearchParams(query())}`;
      // Node's WebSocket takes headers, unlike a browser's.
      const socket = new WebSocket(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      } as unknown as string[]);
      let heard = Date.now();
      let finished: "done" | Error | null = null;
      const pinger = setInterval(() => {
        if (Date.now() - heard > SILENT_MS) socket.close();
        else if (socket.readyState === WebSocket.OPEN) socket.send("ping");
      }, PING_MS);
      socket.onopen = () => {
        attempt = 0;
      };
      socket.onmessage = (event) => {
        heard = Date.now();
        const line = String(event.data);
        if (line === "pong") return;
        const message = JSON.parse(line) as WatchMessage;
        if (message.type === "replaced" && !finished)
          finished = new Error(message.message ?? "Replaced");
        if (message.type === "deleted")
          finished = new Error(message.message ?? "Session not found");
        if (onMessage(message, line) === "done") finished = "done";
        if (finished) socket.close();
      };
      socket.onerror = () => undefined;
      socket.onclose = (event) => {
        clearInterval(pinger);
        if (finished) return resolve(finished);
        if (event.code === 4404) return resolve(new Error("Session not found"));
        resolve("dropped");
      };
    });
    if (ended === "done") return;
    if (ended instanceof Error) throw ended;
    // A refused upgrade only says it failed: ask over HTTP why.
    const probe = await authorizedFetch(
      `/api/sessions/${encodeURIComponent(id)}`,
    ).catch(() => null);
    if (probe && !probe.ok && probe.status !== 429 && probe.status < 500)
      throw new Error(await errorMessage(probe));
    const backoff = Math.min(RECONNECT_MAX_MS, 1_000 * 2 ** attempt);
    await new Promise((resolve) =>
      setTimeout(resolve, backoff / 2 + Math.random() * (backoff / 2)),
    );
  }
}

/**
 * `ask`: `session create`, `question add` and `wait` in one command, for a
 * quick question. Prints the batch with the interview's id and URL.
 */
async function ask(args: string[]) {
  const questions =
    (await jsonInput(args)) ??
    (flag(args, "--prompt") ? questionFromFlags(args) : null);
  if (!questions)
    throw new Error("--json <questions|-> or --prompt is required");
  const session = (await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: flag(args, "--title") ?? "Request",
      origin: detectOrigin(args),
    }),
  })) as { id: string; url: string };
  await api(`/api/sessions/${session.id}/questions`, {
    method: "POST",
    body: JSON.stringify(questions),
  });
  process.stderr.write(`${session.url}\n`);
  const batch = (await nextBatch(session.id, args)) as object;
  output({ interviewId: session.id, url: session.url, ...batch });
}

/** A value as one POSIX shell word. */
const shellQuote = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await authorizedFetch(path, init);
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}
async function errorMessage(response: Response): Promise<string> {
  if (response.status === 401)
    return "Not signed in. Run `kim login` in a terminal.";
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
  const token = await accessToken();
  const response = await send(token);
  if (response.status !== 401) return response;
  const refreshed = await accessToken(token);
  return refreshed ? send(refreshed) : response;
}

interface Credentials {
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

const credentialsFile = () => configFile("credentials.json");

/**
 * A file in the CLI's config folder. The folder was "interviewer" before the
 * rename; a file still only there is copied across on first use.
 */
function configFile(name: string): string {
  const file = join(envPaths("keep-it-moving").config, name);
  const old = join(envPaths("interviewer").config, name);
  if (!existsSync(file) && existsSync(old))
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      copyFileSync(old, file);
      chmodSync(file, 0o600);
    } catch {
      return old;
    }
  return file;
}

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
  // Write then rename, so a concurrent reader never sees half a file.
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

/**
 * Agent keys, for a cloud environment or anywhere the browser sign-in can't
 * run: create one per project's cloud environment and store it there as
 * KEEP_IT_MOVING_TOKEN. Managing keys needs a signed-in CLI, not a key.
 */
async function keyCommand(action: string | undefined, args: string[]) {
  if (action === "create") {
    const name = positional(args, 0);
    const created = (await api("/api/sessions/kim/keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    })) as { key: string };
    output(created);
    process.stderr.write(
      `\nShown once. Store it as KEEP_IT_MOVING_TOKEN in the cloud environment, then revoke it with \`kim key revoke ${name}\`.\n`,
    );
    return;
  }
  if (action === "list") return output(await api("/api/sessions/kim/keys"));
  if (action === "revoke")
    return output(
      await api(
        `/api/sessions/kim/keys/${encodeURIComponent(positional(args, 0))}`,
        { method: "DELETE" },
      ),
    );
  throw new Error(`Unknown key action: ${action ?? ""}`);
}

/**
 * The CLI as an npm-installable tarball, behind the agent API so the
 * environment's key fetches it and nothing extra is public.
 */
const cliPackageUrl = () => `${defaultBase}/api/sessions/kim/cli.tgz`;

/**
 * `cloud setup`: what a project's claude.ai cloud environment needs, ready
 * to paste. It creates the environment's agent key, so it needs a signed-in
 * CLI; an existing key is never shown, since keys can't be read back.
 */
async function cloudCommand(action: string | undefined, args: string[]) {
  if (action !== "setup")
    throw new Error(`Unknown cloud action: ${action ?? ""}`);
  const wanted = flag(args, "--project") ?? repoOrigin().projectKey;
  if (!wanted)
    throw new Error("Not in a git repository; pass --project <key or name>");
  const projects = (await api("/api/sessions/projects")) as Array<{
    key: string;
    name: string;
  }>;
  const known = projects.find(
    (project) =>
      project.key === wanted ||
      project.name.toLowerCase() === wanted.toLowerCase(),
  );
  const project = {
    key: known?.key ?? wanted,
    name: known?.name ?? projectName(wanted),
  };
  const keyName = flag(args, "--key-name") ?? `${project.name} cloud`;
  const { keys } = (await api("/api/sessions/kim/keys")) as {
    keys: Array<{ name: string; revokedAt: string | null }>;
  };
  if (keys.some((key) => key.name === keyName && !key.revokedAt))
    throw new Error(
      `A live key is already named "${keyName}", and keys can't be shown again. ` +
        `Revoke it first (\`kim key revoke ${shellQuote(keyName)}\`) or pass --key-name <another name>.`,
    );
  const { key } = (await api("/api/sessions/kim/keys", {
    method: "POST",
    body: JSON.stringify({ name: keyName }),
  })) as { key: string };
  const host = new URL(defaultBase).host;
  const environment = [
    `KEEP_IT_MOVING_TOKEN=${key}`,
    // Another deployment (such as wrangler dev) has to be named too.
    ...(defaultBase === "https://keep-it-moving.zerobsai.com"
      ? []
      : [`KEEP_IT_MOVING_URL=${defaultBase}`]),
  ].join("\n");
  const setupScript = [
    "#!/bin/bash",
    "# Keep it moving. Nothing here can stop the session from starting.",
    "# The key is the environment's KEEP_IT_MOVING_TOKEN variable.",
    `curl -fsS -H "Authorization: Bearer \${KEEP_IT_MOVING_TOKEN:-$INTERVIEWER_TOKEN}" -o /tmp/kim-cli.tgz ${cliPackageUrl()} && npm install -g /tmp/kim-cli.tgz || true`,
    "exit 0",
  ].join("\n");
  if (args.includes("--json"))
    return output({
      project,
      keyName,
      network: { level: "Custom", allow: [host], keepDefaultPackages: true },
      environment,
      setupScript,
    });
  process.stdout.write(
    `Cloud environment for ${project.name} (${project.key})
Edit the project's environment at claude.ai/code and set these three things.

1. Network access
   Level: Custom
   Allowed domains: ${host}
   Keep the default list of package registries included.

2. Environment variables (anyone using the environment can read them)

${environment}

3. Setup script

${setupScript}

The key "${keyName}" is shown only here. Revoke it with:
  kim key revoke ${shellQuote(keyName)}
`,
  );
}

/**
 * The stored access token, refreshed when it is about to expire or the
 * server refused it (`rejected`). Agents run several CLI processes at once,
 * and each refresh rotates the refresh token, so refreshes take a lock and
 * reuse a token another process has just fetched; otherwise a process could
 * save a refresh token the server had already replaced, signing the CLI out.
 */
/** The installed package: dist/ (or src/) sits in it beside skills/ and build.json. */
const packageRoot = () => fileURLToPath(new URL("..", import.meta.url));
const skillPaths = (): SkillPaths => ({
  home: homedir(),
  source: join(packageRoot(), "skills", "interviewer"),
  choiceFile: configFile("skill.json"),
});

/**
 * `skill install` copies the bundled skill to ~/.agents/skills and links it
 * into the chosen agents' skills folders: picked from a checklist in a
 * terminal, else `--agents claude,codex` or `--all`, else the agents chosen
 * last time, else Claude Code. `skill uninstall` removes only what it made;
 * `skill refresh` brings the copy up to date, as every run does.
 */
async function skillCommand(action: string | undefined, args: string[]) {
  const paths = skillPaths();
  if (action === "install") {
    const agents = await chooseAgents(args, paths);
    if (!agents) throw new Error("Cancelled");
    const result = installSkill(paths, agents, args.includes("--force"));
    output(result);
    if (result.skipped.length) process.exitCode = 1;
    return;
  }
  if (action === "uninstall") return output(uninstallSkill(paths));
  if (action === "refresh")
    return output({
      canonical: canonicalSkill(paths.home),
      refreshed: refreshSkill(paths),
    });
  throw new Error(`Unknown skill action: ${action ?? ""}`);
}

async function chooseAgents(
  args: string[],
  paths: SkillPaths,
): Promise<AgentId[] | null> {
  if (args.includes("--all")) return SKILL_AGENTS.map((agent) => agent.id);
  const list = flag(args, "--agents");
  if (list) return parseAgents(list);
  const remembered = rememberedAgents(paths.choiceFile);
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const present = installedAgents(paths.home);
    const preselected =
      remembered ?? (present.length ? present : (["claude"] as AgentId[]));
    return checkbox(
      "Install the interviewer skill for which agents?",
      SKILL_AGENTS.map((agent) => ({
        value: agent.id,
        label: `${agent.name} (~/${agent.home}/skills)`,
        checked: preselected.includes(agent.id),
      })),
    );
  }
  if (remembered) return remembered;
  process.stderr.write(
    "Installing for Claude Code only. Run `kim skill install` in a terminal to choose, or pass --agents claude,codex,pi or --all.\n",
  );
  return ["claude"];
}

/** Reinstalls the CLI from the site, then refreshes the skill with the new one. */
function update() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // npm's output goes to stderr, keeping stdout for the JSON result.
  const installed = spawnSync(
    npm,
    ["install", "-g", `${defaultBase}/cli.tgz`],
    { stdio: ["inherit", 2, 2], shell: process.platform === "win32" },
  );
  if (installed.status !== 0)
    throw new Error(`npm install -g ${defaultBase}/cli.tgz failed`);
  const refreshed = spawnSync("kim", ["skill", "refresh"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", 2],
    shell: process.platform === "win32",
  });
  let skill: unknown = null;
  try {
    skill = JSON.parse(refreshed.stdout);
  } catch {
    // An older kim on PATH; the next run refreshes the skill anyway.
  }
  output({ updated: true, skill });
}

/**
 * What every run does first: refresh an installed skill copy that's out of
 * date, and once a day hint on stderr that a newer CLI exists. Neither
 * writes to stdout, holds up the command, or fails it.
 */
function housekeeping(group: string | undefined) {
  if (group !== "skill" && group !== "update")
    try {
      refreshSkill(skillPaths());
    } catch {
      // The command matters more than the skill copy.
    }
  const current = readBuild(join(packageRoot(), "build.json"));
  if (!current || group === "update") return;
  void checkForUpdate({
    base: defaultBase,
    current,
    stateFile: configFile("update-check.json"),
  }).then((hint) => {
    if (hint) process.stderr.write(`${hint}\n`);
  });
}

async function accessToken(rejected?: string | null): Promise<string | null> {
  const token = setting("TOKEN");
  if (token) return token;
  const usable = (stored: Credentials | undefined) =>
    stored &&
    stored.accessToken !== rejected &&
    stored.expiresAt - Date.now() > 60_000;
  const before = readCredentials()[defaultBase];
  if (!before) return null;
  if (usable(before)) return before.accessToken;
  return withRefreshLock(async () => {
    const stored = readCredentials()[defaultBase];
    if (!stored) return null;
    if (usable(stored)) return stored.accessToken;
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
  });
}

/** How long a refresh lock is honoured before it counts as left by a dead process. */
const REFRESH_LOCK_STALE_MS = 30_000;

/** Runs `fn` while holding a lock directory beside the credentials. */
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = `${credentialsFile()}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + REFRESH_LOCK_STALE_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > REFRESH_LOCK_STALE_MS || Date.now() > deadline)
        rmSync(lock, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
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
 * Signs in through the browser: Google sign-in on the Worker, then
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
        client_name: "Keep it moving CLI",
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
const BOOLEAN_FLAGS = new Set([
  "--all",
  "--show",
  "--stdin",
  "--open-stage",
  "--clear",
  "--force",
]);

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
    `kim — Keep it moving: interviews with your agents (${defaultBase})
(\`interviewer\` is the same command.)

Commands:
  login | logout | whoami   sign in through the browser (Google, then OAuth)
  session create --title <text> [--open-stage] [--agent-session <your session title>] [--project <name>] [--assign <email>]
    the workspace column starts closed unless --open-stage; the project comes from the git remote
  session assign <session> <email> | --clear
    someone else answers it: they sign in with Google as that email at the url; answers come back to you
  session list [--all]|show <id>|stop <id>|resume <id>
  session delete <id> [<id>...] | --stopped   delete interviews, or every stopped one; prints what went
  project list   the projects interviews are labelled with
  question add <session> --prompt <text> [--type <type>] [--option <text>] [--default <text>] [--recommendation <text>] [--artifact <id>]
  types: text, single-choice, multiple-choice, yes-no, number; repeat --option/--default
  question add|update <session> [question] --json '<object>'  (use --json - for stdin)
  question delete|focus|reorder <session> <question> [--position N]
  ask --title <text> --json <questions|-> | --prompt <text> … [--idle MS] [--timeout MS]
    a quick question: session create, question add and wait in one; prints the batch with its interviewId
  wait <session> [--idle MS] [--timeout MS]   one batch of answers once the user pauses
    the user's chat messages wake it too and arrive in \`messages\`
  chat list <session>   the interview's chat with the user
  chat reply <session> --text "…" | --file <path|-> [--to <message>]   answer the user in the chat (Markdown)
  attach <session>
  events next <session> [--timeout MS]
  plan <session> --file <path|-> | --content <md> [--show]   create or replace the plan document
  artifact add <session> --file <path|-> [--kind document|diagram|mockup] [--title T] [--description D] [--show]
    diagrams: an archify spec (.json with diagram_type) is validated and rendered; also archify HTML or SVG
  artifact update <session> <artifact> [--file|--content] [--title] [--description] [--show] [--quality showcase]
  artifact show <session> <artifact|none>   choose what the workspace shows
  artifact delete <session> <artifact>
  stage open|close <session>   show or hide the workspace column

Cloud sessions (claude.ai/code):
  key create <name> | list | revoke <id|name>   agent keys for cloud environments (KEEP_IT_MOVING_TOKEN)
  cloud setup [--project <key>] [--key-name <name>] [--json]
    creates the project's agent key and prints its cloud environment's network
    access, environment variables and setup script, ready to paste

Setup:
  skill install [--agents claude,codex,pi | --all] [--force]
    copy the interviewer skill to ~/.agents/skills and link it into each agent's
    skills folder; asks which agents in a terminal, and remembers the choice.
    It never replaces a link or folder it didn't make unless --force
  skill uninstall   remove the links and copy skill install made
  skill refresh     bring the skill copy up to date (every run does this)
  update   reinstall kim from this site, then refresh the skill

KEEP_IT_MOVING_URL points at another deployment, such as wrangler dev.
`,
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});
