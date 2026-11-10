#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import envPaths from "env-paths";
import { checkbox } from "./checkbox.js";
import { normalizeRemote, projectName } from "./shared/remote.js";
import {
  findBrowser,
  NoBrowser,
  renderDesignSvg,
  renderScreenshot,
} from "./render.js";
import { encodeContentKey, Encryption } from "./sealedApi.js";
import {
  handoffCode,
  importAccountKey,
  newAccountKey,
  unwrapWith,
} from "./shared/crypto.js";
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
  skillsFolder,
  uninstallSkill,
} from "./skill.js";
import {
  armWaiter,
  bindSession,
  disarmWaiter,
  liveBindings,
  readBindings,
  runHook,
  runStop,
  unbindInterview,
  waiterArmed,
  type HookPayload,
  type InboxNews,
  type StopWaitOutcome,
  type TakeOutcome,
} from "./hook.js";
import {
  HOOK_AGENTS,
  hookEventFor,
  STOP_HOLD_TIMEOUT_S,
  STOP_WAIT_TIMEOUT_S,
  forgetInstalledHooks,
  hooksStatus,
  isHookAgent,
  refreshHooks,
  setHooksOptOut,
  uninstallHooks,
  type HookAgentId,
  type HookRefreshResult,
} from "./hooks.js";
import {
  acquireUpdateLock,
  autoUpdateBlocked,
  checkForUpdate,
  decideUpdate,
  readBuild,
  readUpdateState,
  UPDATE_HINT,
  updateDue,
  updateLocked,
  writeUpdateState,
} from "./update.js";
import { checkDesign, DesignCheckError, type Finding } from "./designCheck.js";
import { designTypeOf, parseDesignType } from "./designFiles.js";
import type { DesignType } from "./shared/designs.js";
import {
  applyWrites,
  defaultPath,
  keepRefusal,
  kimPath,
  linksTokens,
  TOKENS_PATH,
  listKimFiles,
  planWrites,
  previewPath,
  pullItem,
  repoRoot,
  type KeptItem,
  type KeptSession,
  type WriteStep,
} from "./designSync.js";

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
  // Hooks run between an agent's steps: no housekeeping, and never an error.
  if (args[0] === "hook") return hookCommand(args[1]);
  housekeeping(args[0]);
  if (!args.length || args.includes("--help") || args[0] === "help")
    return printHelp();
  const [group, action, ...rest] = args;
  if (group === "update")
    return args.includes("--background") ? backgroundUpdate(args) : update();
  if (group === "hooks") return hooksCommand(action, rest);
  if (group === "login") return login();
  if (group === "logout") return logout();
  if (group === "whoami") return whoami();
  if (group === "session") return sessionCommand(action, rest);
  if (group === "question") return questionCommand(action, rest);
  if (group === "artifact") return artifactCommand(action, rest);
  if (group === "design") return designCommand(action, rest);
  if (group === "stage") return stageCommand(action, rest);
  if (group === "chat") return chatCommand(action, rest);
  if (group === "project") return projectCommand(action);
  if (group === "key") return keyCommand(action, rest);
  if (group === "cloud") return cloudCommand(action, rest);
  if (group === "skill") return skillCommand(action, rest);
  if (group === "inbox") return inboxCommand(action, rest);
  if (group === "draft")
    return draftCommand(
      [action, ...rest].filter((value): value is string => Boolean(value)),
    );
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
    bindToAgentSession((session as { id: string }).id);
    const assignee = flag(args, "--assign");
    if (!assignee) return output(session);
    const { id } = session as { id: string };
    try {
      return output({
        ...(session as object),
        ...((await assign(id, assignee)) as object),
      });
    } catch (error) {
      // Say what was made, so a refused assign doesn't strand it.
      if (error instanceof ApiError)
        throw new ApiError(
          `${error.message} The interview was created without an assignee: ${id}`,
          { ...error.details, session },
        );
      throw error;
    }
  }
  if (action === "list")
    return output(
      await api(`/api/sessions${args.includes("--all") ? "?all=true" : ""}`),
    );
  if (action === "delete") return deleteSessions(args);
  const id = positional(args, 0);
  if (action === "show") return output(await api(`/api/sessions/${id}`));
  if (action === "stop" || action === "resume") {
    // What the agent kept goes into the repo first; a conflict leaves the
    // interview running so the agent can merge and stop again.
    const write =
      action === "stop" && !args.includes("--no-write")
        ? await writeKept(id, { dryRun: false, quiet: true })
        : null;
    if (write?.conflicts.length) {
      output(write);
      process.exitCode = 1;
      return;
    }
    const result = (await api(`/api/sessions/${id}/${action}`, {
      method: "POST",
    })) as Record<string, unknown>;
    if (action === "stop") forgetBinding(id);
    else bindToAgentSession(id);
    if (!write) return output(result);
    const wrote: Record<string, unknown> = { ...write };
    delete wrote.conflicts;
    return output({ ...result, ...wrote });
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
      forgetBinding(id);
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
  css: "tokens",
};

/**
 * A saved design's response, with how it lays out: what to change, though
 * it was saved either way.
 */
function withWarnings(response: unknown, warnings: Finding[]): unknown {
  if (warnings.length === 0 || typeof response !== "object" || !response)
    return response;
  return {
    ...response,
    layout: {
      warnings,
      note: "Saved. These make it harder to read; fix what's cheap and update it, or tell the user why not.",
    },
  };
}

/** Artifact fields from a file or --content. */
async function artifactInput(args: string[]): Promise<{ content?: string }> {
  const content = await artifactContent(args);
  return content === undefined ? {} : { content };
}

function artifactFields(args: string[], input: { content?: string }) {
  const fields: Record<string, unknown> = {};
  const title = flag(args, "--title");
  if (title) fields.title = title;
  if (input.content !== undefined) fields.content = input.content;
  const description = flag(args, "--description");
  if (description !== undefined) fields.description = description;
  if (args.includes("--show")) fields.show = true;
  if (args.includes("--keep")) fields.keep = true;
  if (args.includes("--no-keep")) fields.keep = false;
  const base = flag(args, "--base");
  const repoPath = flag(args, "--repo-path");
  if (base !== undefined || repoPath !== undefined) {
    if (!repoPath)
      throw new Error(
        "--base needs --repo-path, the file's path in the repo (e.g. .kim/designs/data-model.dbml)",
      );
    fields.repo = {
      path: repoPath,
      baseCommit: flag(args, "--base-commit") ?? null,
      baseContent: base === undefined ? null : readFileSync(base, "utf8"),
    };
  }
  return fields;
}

/** The repo the current directory is in, which must be the interview's. */
async function interviewRepo(sessionId: string): Promise<string> {
  const root = repoRoot(process.cwd());
  if (!root)
    throw new Error(
      "Run this inside the interview's repo: kim reads and writes its .kim/ folder",
    );
  const session = (await api(`/api/sessions/${sessionId}`)) as {
    project: { key: string } | null;
  };
  const here = repoOrigin(root).projectKey;
  // A repo keeps the key it had before it got a remote: its folder's name.
  const common = git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const keys = [
    here,
    common && `local/${basename(dirname(common)).toLowerCase()}`,
  ];
  if (session.project && here && !keys.includes(session.project.key))
    throw new Error(
      `This interview belongs to ${session.project.key}, but this folder is in ${here}; run it from that repo`,
    );
  return root;
}

interface KeptResponse {
  session: KeptSession & { status: string };
  artifacts: KeptItem[];
}

/**
 * Writes what the agent kept into the repo's .kim/ folder. Nothing is
 * written if any file changed since the interview copied it: each
 * conflict's versions are saved for the agent to merge.
 */
async function writeKept(
  sessionId: string,
  options: { dryRun: boolean; quiet: boolean },
) {
  // A deployment from before .kim/ has nothing kept, and stopping still works.
  const response = await authorizedFetch(`/api/sessions/${sessionId}/kept`);
  if (response.status === 404 && options.quiet) return null;
  if (!response.ok) throw await apiError(response);
  const kept = await encryption.open((await response.json()) as KeptResponse);
  if (!kept.artifacts.length) {
    if (options.quiet) return null;
    return { written: [], conflicts: [], note: "Nothing is marked to keep" };
  }
  const root = await interviewRepo(sessionId);
  const steps = planWrites(root, kept.session, kept.artifacts);
  const summary = (step: WriteStep) => ({
    artifactId: step.artifactId,
    title: step.title,
    path: step.path,
    action: step.action,
  });
  if (options.dryRun) return { plan: steps.map(summary), conflicts: [] };
  const { written, conflicts } = applyWrites(root, steps);
  const previews = conflicts.length
    ? { written: [], failed: [] }
    : await writePreviews(sessionId, root, kept.artifacts, steps);
  return {
    written: written.map(summary),
    ...(previews.written.length ? { previews: previews.written } : {}),
    ...(previews.failed.length ? { previewsFailed: previews.failed } : {}),
    unchanged: steps
      .filter((step) => step.action === "unchanged")
      .map((step) => step.path),
    conflicts,
    ...(conflicts.length
      ? {
          nextStep:
            "Nothing was written. Each conflict's file changed since the interview copied it. Merge ours with theirs (base is what the interview started from), then run `kim design rebase <session> <artifact> --file <merged>` for each, show the user, and write again.",
        }
      : {}),
  };
}

/**
 * Each written design's rendered SVG, beside it in the repo, so a PR shows
 * the picture: the design viewer draws it in a browser on this machine
 * and exports it. A design that didn't change gets one only if it has
 * none. A preview that fails leaves the design written, and says why.
 */
async function writePreviews(
  sessionId: string,
  root: string,
  items: KeptItem[],
  steps: WriteStep[],
) {
  const written: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  let browser: string | null | undefined;
  for (const step of steps) {
    const item = items.find((candidate) => candidate.id === step.artifactId);
    if (item?.kind !== "design") continue;
    const path = previewPath(step.path);
    if (step.action === "unchanged" && existsSync(join(root, path))) continue;
    if (browser === undefined)
      try {
        browser = findBrowser();
      } catch (error) {
        if (!(error instanceof NoBrowser)) throw error;
        browser = null;
      }
    if (!browser) {
      failed.push({
        path,
        error:
          "No Chrome, Edge or Chromium here to draw it with (KIM_BROWSER names one); the design is written without its preview",
      });
      continue;
    }
    try {
      const { content } = (await api(
        `/api/sessions/${sessionId}/artifacts/${item.id}/page`,
      )) as { content: string };
      writeFileSync(
        join(root, path),
        await renderDesignSvg(content, defaultBase, browser),
      );
      written.push(path);
    } catch (error) {
      failed.push({
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { written, failed };
}

async function designCommand(action: string | undefined, args: string[]) {
  if (action === "list") {
    const root = repoRoot(process.cwd());
    if (!root) throw new Error("Run this inside a repo");
    return output({ root, files: listKimFiles(root) });
  }
  const sessionId = positional(args, 0);
  if (!sessionId) throw new Error("A session id is required");
  if (action === "pull") {
    const paths = args.slice(1).filter((arg, index, all) => {
      if (arg.startsWith("--")) return false;
      const previous = all[index - 1];
      return previous !== "--title" && previous !== "--description";
    });
    if (!paths.length) throw new Error("Name the .kim/ files to pull");
    const root = await interviewRepo(sessionId);
    const added = [];
    // A mockup using the design system needs its tokens to draw; they
    // come along, out of sight until the interview changes them.
    const linked = paths.some((path) => {
      const file = kimPath(root, process.cwd(), path);
      return (
        /\.html?$/i.test(file) &&
        linksTokens(readFileSync(join(root, file), "utf8"))
      );
    });
    if (
      linked &&
      existsSync(join(root, TOKENS_PATH)) &&
      !paths.some((path) => kimPath(root, process.cwd(), path) === TOKENS_PATH)
    ) {
      const session = (await api(`/api/sessions/${sessionId}`)) as {
        artifacts: Array<{ kind: string }>;
      };
      if (!session.artifacts.some((artifact) => artifact.kind === "tokens"))
        added.push(
          await api(`/api/sessions/${sessionId}/artifacts`, {
            method: "POST",
            body: JSON.stringify({
              ...pullItem(root, TOKENS_PATH),
              title: "Design system",
            }),
          }),
        );
    }
    for (const path of paths) {
      const item = pullItem(root, kimPath(root, process.cwd(), path));
      const refusal = args.includes("--keep") && keepRefusal(item);
      if (refusal) throw new Error(refusal);
      const title = paths.length === 1 ? flag(args, "--title") : undefined;
      const description = flag(args, "--description");
      added.push(
        await api(`/api/sessions/${sessionId}/artifacts`, {
          method: "POST",
          body: JSON.stringify({
            ...item,
            title: title ?? item.title,
            ...(description !== undefined ? { description } : {}),
            keep: args.includes("--keep"),
            show: args.includes("--show"),
          }),
        }),
      );
    }
    return output({ artifacts: added });
  }
  if (action === "keep" || action === "drop") {
    const artifactId = positional(args, 1);
    if (!artifactId) throw new Error("An artifact id is required");
    if (action === "keep") {
      const session = (await api(`/api/sessions/${sessionId}`)) as {
        artifacts: Array<{
          id: string;
          kind: KeptItem["kind"];
          title: string;
          repo?: { path: string };
        }>;
      };
      const artifact = session.artifacts.find((item) => item.id === artifactId);
      if (!artifact) throw new Error("Artifact not found");
      const refusal = keepRefusal({ ...artifact, repo: artifact.repo ?? null });
      if (refusal) throw new Error(refusal);
    }
    return output(
      await api(`/api/sessions/${sessionId}/artifacts/${artifactId}`, {
        method: "PATCH",
        body: JSON.stringify({ keep: action === "keep" }),
      }),
    );
  }
  if (action === "write")
    return output(
      (await writeKept(sessionId, {
        dryRun: args.includes("--dry-run"),
        quiet: false,
      }))!,
    );
  if (action === "rebase") {
    // After a conflict: the merged version becomes the interview's, and
    // the repo file as it is now becomes what it is compared with.
    const artifactId = positional(args, 1);
    const file = flag(args, "--file");
    if (!artifactId || !file)
      throw new Error(
        "Usage: kim design rebase <session> <artifact> --file <merged>",
      );
    const kept = (await api(`/api/sessions/${sessionId}/kept`)) as KeptResponse;
    const item = kept.artifacts.find((artifact) => artifact.id === artifactId);
    if (!item) throw new Error("That artifact isn't marked to keep");
    const root = await interviewRepo(sessionId);
    const path = item.repo?.path ?? defaultPath(item, kept.session);
    const current = join(root, path);
    return output(
      await api(`/api/sessions/${sessionId}/artifacts/${artifactId}`, {
        method: "PATCH",
        body: JSON.stringify({
          content: readFileSync(file === "-" ? 0 : file, "utf8"),
          repo: {
            path,
            baseCommit: git(root, "rev-parse", "HEAD"),
            baseContent: existsSync(current)
              ? readFileSync(current, "utf8")
              : null,
          },
          show: true,
        }),
      }),
    );
  }
  throw new Error(`Unknown design action: ${action ?? ""}`);
}

async function artifactCommand(action: string | undefined, args: string[]) {
  const sessionId = positional(args, 0);
  if (action === "add") {
    const input = await artifactInput(args);
    if (input.content === undefined)
      throw new Error("--file <path|-> or --content is required");
    const file = flag(args, "--file");
    const typeFlag = flag(args, "--type");
    const designType = typeFlag
      ? parseDesignType(typeFlag)
      : designTypeOf(file, input.content);
    const kind = designType
      ? "design"
      : (flag(args, "--kind") ??
        KIND_BY_EXTENSION[file?.split(".").pop()?.toLowerCase() ?? ""]);
    if (!kind)
      throw new Error(
        "--kind is required (document, diagram, mockup); designs (.dbml, .d2, .mmd, OpenAPI .yaml) are detected",
      );
    if (kind === "design" && !designType)
      throw new Error(
        "A design needs --type (data-model, architecture, data-flow, sequence, state, api)",
      );
    const warnings = designType
      ? await checkDesign(designType, input.content, file)
      : [];
    const fields = artifactFields(args, input);
    if (designType) fields.designType = designType;
    fields.title ??= file?.split("/").pop() ?? "Untitled";
    return output(
      withWarnings(
        await api(`/api/sessions/${sessionId}/artifacts`, {
          method: "POST",
          body: JSON.stringify({ kind, ...fields }),
        }),
        warnings,
      ),
    );
  }
  const artifactId = positional(args, 1);
  if (action === "update") {
    const input = await artifactInput(args);
    let warnings: Finding[] = [];
    if (input.content !== undefined) {
      const view = (await api(`/api/sessions/${sessionId}`)) as {
        artifacts?: Array<{ id: string; designType?: DesignType | null }>;
      };
      const designType = view.artifacts?.find(
        (artifact) => artifact.id === artifactId,
      )?.designType;
      if (designType)
        warnings = await checkDesign(
          designType,
          input.content,
          flag(args, "--file"),
        );
    }
    return output(
      withWarnings(
        await api(`/api/sessions/${sessionId}/artifacts/${artifactId}`, {
          method: "PATCH",
          body: JSON.stringify(artifactFields(args, input)),
        }),
        warnings,
      ),
    );
  }
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

/** An interview sent to the user, by its token or its page's URL. */
function interviewRef(value: string): string {
  const token = /\/s\/([A-Za-z0-9_-]{32})(?:[/?#]|$)/.exec(value)?.[1] ?? value;
  return encodeURIComponent(token);
}

/**
 * `inbox`: interviews other people sent to the user, as the user's own
 * agent works on them. It reads, drafts and chats; it never changes the
 * interview itself.
 */
async function inboxCommand(action: string | undefined, args: string[]) {
  if (action === undefined || action === "list")
    return output(await api("/api/sessions/inbox"));
  if (action === "wait") return inboxWait(args);
  const interview = interviewRef(positional(args, 0));
  const base = `/api/sessions/inbox/${interview}`;
  if (action === "show") {
    const view = (await api(base)) as {
      artifacts: Array<{ id: string; format: string; content?: string }>;
    };
    // What isn't inline is a command away.
    for (const artifact of view.artifacts)
      if (artifact.content === undefined)
        Object.assign(artifact, {
          fetch: `kim inbox artifact ${interview} ${artifact.id} --out <file>`,
          ...(artifact.format === "html"
            ? { screenshot: `kim inbox screenshot ${interview} ${artifact.id}` }
            : {}),
        });
    return output(view);
  }
  if (action === "artifact") {
    const artifact = (await encryption.inboxArtifact(
      await api(`${base}/artifacts/${encodeURIComponent(positional(args, 1))}`),
    )) as { content: string };
    const out = flag(args, "--out");
    if (!out) return output(artifact);
    writeFileSync(out, artifact.content);
    return output({ ...artifact, content: undefined, file: resolve(out) });
  }
  if (action === "screenshot") return inboxScreenshot(interview, args);
  if (action === "chat") {
    const text = positionals(args).slice(1).join(" ");
    if (!text.trim())
      throw new Error("Give the message: kim inbox chat <interview> <text>");
    const question = flag(args, "--question");
    return output(
      await api(`${base}/chat`, {
        method: "POST",
        body: JSON.stringify({ text, ...(question ? { question } : {}) }),
      }),
    );
  }
  throw new Error(`Unknown inbox action: ${action}`);
}

/**
 * `draft <interview> <question> [answer…]`: a draft answer the user
 * reviews and sends in the browser, or with --send their answer now.
 * The question is its id or number; choices take --option, repeated, and
 * the form's "Other, or add a note" is --note.
 */
async function draftCommand(args: string[]) {
  const interview = interviewRef(positional(args, 0));
  const question = encodeURIComponent(positional(args, 1));
  const path = `/api/sessions/inbox/${interview}/questions/${question}`;
  if (args.includes("--clear"))
    return output(await api(`${path}/draft`, { method: "DELETE" }));
  const answer = positionals(args).slice(2).join(" ");
  const options = flags(args, "--option");
  const note = flag(args, "--note");
  const body = JSON.stringify({
    ...(answer ? { answer } : {}),
    ...(options.length ? { options } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(args.includes("--skip") ? { skipped: true } : {}),
  });
  return output(
    args.includes("--send")
      ? await api(`${path}/answer`, { method: "POST", body })
      : await api(`${path}/draft`, { method: "PUT", body }),
  );
}

/**
 * Renders an html or svg artifact, as its frame shows it, to a PNG in a
 * browser on this machine (see render.ts); the service only hands over the
 * page. With no browser here, it saves the page for the agent's own
 * browser tool, or for reading.
 */
async function inboxScreenshot(interview: string, args: string[]) {
  const id = positional(args, 1);
  const artifact = (await encryption.inboxArtifact(
    await api(
      `/api/sessions/inbox/${interview}/artifacts/${encodeURIComponent(id)}`,
    ),
  )) as {
    title: string;
    format: string;
    revision: number;
    frame: { width: number; height: number | null };
    content: string;
  };
  if (artifact.format !== "html" && artifact.format !== "svg")
    throw new Error(
      `"${artifact.title}" is ${artifact.format}, not a page; read it with kim inbox artifact`,
    );
  const width = Number(flag(args, "--width") ?? artifact.frame.width);
  if (!Number.isInteger(width) || width < 100 || width > 4_000)
    throw new Error("--width is a number of pixels, such as 1280, 834 or 390");
  const fullPage = args.includes("--full-page");
  const name = `${id.replace(/[^A-Za-z0-9_-]+/g, "-")}-r${artifact.revision}-${width}${fullPage ? "-full" : ""}`;
  const folder = join(tmpdir(), "kim-screenshots");
  let shot: { png: Buffer; height: number };
  try {
    shot = await renderScreenshot({
      format: artifact.format,
      content: artifact.content,
      width,
      height: artifact.frame.height ?? 800,
      fullPage,
    });
  } catch (error) {
    if (!(error instanceof NoBrowser)) throw error;
    const page = join(folder, `${name}.${artifact.format}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(page, artifact.content);
    throw new Error(
      `${error.message}. The page is saved at ${page}: open it at ${width}px wide with your own browser tool to see it, or read it.`,
    );
  }
  const out = resolve(flag(args, "--out") ?? join(folder, `${name}.png`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, shot.png);
  return output({
    file: out,
    width,
    height: shot.height,
    revision: artifact.revision,
  });
}

/**
 * `inbox wait [<interview>]`: blocks until something new arrives in an
 * interview sent to the user (or any of them): a question, the sender's
 * agent's reply, a workspace change, or a newly sent interview. What it
 * prints counts as delivered, so the next wait brings only what is newer.
 */
async function inboxWait(args: string[]) {
  const only = positionals(args)[0];
  const interview = only ? interviewRef(only) : null;
  const idle = Number(flag(args, "--idle") ?? 2_000);
  const timeout = Number(flag(args, "--timeout") ?? 600_000);
  const take = async (): Promise<InboxNews[]> =>
    interview
      ? [
          (await api(`/api/sessions/inbox/${interview}/take`, {
            method: "POST",
          })) as InboxNews,
        ].filter((news) => news.news)
      : (
          (await api("/api/sessions/inbox/take", { method: "POST" })) as {
            interviews: InboxNews[];
          }
        ).interviews;
  let found: InboxNews[] = [];
  // One take at a time, and none once something was found: a take marks
  // what it returns delivered.
  let taking: Promise<"done" | undefined> = Promise.resolve(undefined);
  const check = (settle: number) => {
    taking = taking.then(async (done) => {
      if (done || found.length) return "done";
      if (settle) await new Promise((wake) => setTimeout(wake, settle));
      if (found.length) return "done";
      found = await take();
      return found.length ? "done" : undefined;
    });
    return taking;
  };
  const signal = AbortSignal.timeout(timeout);
  await watchSocket(
    "/api/sessions/inbox/socket",
    () => ({}),
    (message) => {
      if (message.type !== "changed") return;
      if (interview && message.interview !== decodeURIComponent(interview))
        return;
      return check(idle);
    },
    // Anything that came while nothing waited is news at once.
    { onOpen: () => check(0), signal },
  );
  output(
    found.length ? { interviews: found } : { interviews: [], timedOut: true },
  );
}

async function attach(args: string[]) {
  const id = positional(args, 0);
  process.stdout.on("error", () => process.exit(0));
  // Lines are opened in order: each waits for the one before it.
  let printed = Promise.resolve();
  await watchInterview(
    id,
    () => ({ mode: "attach" }),
    (message, line) => {
      printed = printed.then(async () => {
        const opened = await encryption.open(message).catch(() => message);
        process.stdout.write(
          `${opened === message ? line : JSON.stringify(opened)}\n`,
        );
      });
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
  output(await encryption.open(result));
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
  return encryption.open(batch);
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
const watchInterview = (
  id: string,
  query: () => Record<string, string>,
  onMessage: (message: WatchMessage, line: string) => "done" | undefined,
) =>
  watchSocket(
    `/api/sessions/${encodeURIComponent(id)}/socket`,
    query,
    onMessage,
  );

type Watched = "done" | undefined;

/**
 * The socket behind `watchInterview` and `inbox wait`. `onOpen` runs on
 * each connection; either it or `onMessage` may finish the watch, now or
 * once a promise settles. An aborted `signal` ends it quietly.
 */
async function watchSocket(
  path: string,
  query: () => Record<string, string>,
  onMessage: (
    message: WatchMessage,
    line: string,
  ) => Watched | Promise<Watched>,
  extra: {
    onOpen?: () => Watched | Promise<Watched>;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const { signal } = extra;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return;
    const token = await accessToken();
    const ended = await new Promise<"done" | "dropped" | Error>((resolve) => {
      const url = `${defaultBase.replace(/^http/, "ws")}${path}?${new URLSearchParams(query())}`;
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
      const settle = (result: Watched | Promise<Watched>) =>
        void Promise.resolve(result).then(
          (value) => {
            if (value !== "done" || finished) return;
            finished = "done";
            socket.close();
          },
          (error: unknown) => {
            if (finished) return;
            finished =
              error instanceof Error ? error : new Error(String(error));
            socket.close();
          },
        );
      const abort = () => {
        finished ??= "done";
        socket.close();
      };
      signal?.addEventListener("abort", abort, { once: true });
      socket.onopen = () => {
        attempt = 0;
        if (extra.onOpen) settle(extra.onOpen());
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
        const result = onMessage(message, line);
        if (result === "done") finished = "done";
        else if (result && !finished) settle(result);
        if (finished) socket.close();
      };
      socket.onerror = () => undefined;
      socket.onclose = (event) => {
        clearInterval(pinger);
        signal?.removeEventListener("abort", abort);
        if (finished) return resolve(finished);
        if (event.code === 4404) return resolve(new Error("Session not found"));
        resolve("dropped");
      };
    });
    if (ended === "done") return;
    if (ended instanceof Error) throw ended;
    // A refused upgrade only says it failed: ask the same route over HTTP
    // why, such as the Free plan's limit. 426 means it would take a socket.
    const probe = await authorizedFetch(
      `${path}?${new URLSearchParams(query())}`,
    ).catch(() => null);
    if (
      probe &&
      !probe.ok &&
      probe.status !== 426 &&
      probe.status !== 429 &&
      probe.status < 500
    )
      throw await apiError(probe);
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
  bindToAgentSession(session.id);
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

/** A request to the service, through end-to-end encryption (see sealedApi.ts). */
const api = (path: string, init?: RequestInit): Promise<unknown> =>
  encryption.api(path, init);

/** A request as the service sees it: sealed fields stay sealed. */
async function rawApi(path: string, init?: RequestInit): Promise<unknown> {
  const response = await authorizedFetch(path, init);
  if (!response.ok) throw await apiError(response);
  return response.json();
}

/**
 * The account's private key, which opens encrypted interviews: from the
 * environment in a cloud session, else as `kim login` stored it.
 */
const storedContentKey = () =>
  process.env.KEEP_IT_MOVING_CONTENT_KEY?.trim() ||
  readCredentials()[defaultBase]?.contentKey ||
  null;

const encryption = new Encryption(rawApi, storedContentKey);

/**
 * A refusal from the service. A plan limit (402, code "plan_limit") keeps
 * the rest of its body, such as the live interviews and the upgrade URL,
 * and prints it beside the error.
 */
class ApiError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
async function apiError(response: Response): Promise<ApiError> {
  if (response.status === 401)
    return new ApiError("Not signed in. Run `kim login` in a terminal.");
  const value = (await response
    .json()
    .catch(() => ({ error: response.statusText }))) as {
    error?: string;
    code?: string;
  };
  const { error, ...details } = value;
  return new ApiError(
    error ?? `HTTP ${response.status}`,
    value.code === "plan_limit" ? details : {},
  );
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
  /** The account's encryption key (PKCS #8, base64url), from `kim login`. */
  contentKey?: string;
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
  // Encrypted interviews open with the account's key: the environment needs it too.
  const contentKey = (
    (await rawApi("/api/sessions/kim/account")) as { publicKey: unknown }
  ).publicKey
    ? storedContentKey()
    : null;
  const environment = [
    `KEEP_IT_MOVING_TOKEN=${key}`,
    ...(contentKey ? [`KEEP_IT_MOVING_CONTENT_KEY=${contentKey}`] : []),
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
 * terminal, else `--agents claude,codex` or `--all` (every agent found
 * here), else the agents chosen
 * last time, else Claude Code. `skill uninstall` removes only what it made;
 * `skill refresh` brings the copy up to date, as every run does.
 */
async function skillCommand(action: string | undefined, args: string[]) {
  const paths = skillPaths();
  if (action === "install") {
    const agents = await chooseAgents(args, paths);
    if (!agents) throw new Error("Cancelled");
    const result = installSkill(paths, agents, args.includes("--force"));
    const hookAgents = agents.filter(isHookAgent);
    // --no-hooks opts out, as `hooks uninstall` does; --hooks opts back in.
    if (args.includes("--no-hooks") || args.includes("--hooks"))
      setHooksOptOut(hooksStateFile(), hookAgents, args.includes("--no-hooks"));
    const hooks = refreshHooks(hookAgents, paths.home, hooksStateFile(), {
      force: true,
    });
    noteHooks(hooks);
    output({ ...result, hooks });
    if (result.skipped.length || hooks.some((hook) => "error" in hook))
      process.exitCode = 1;
    return;
  }
  if (action === "uninstall") return output(uninstallSkill(paths));
  if (action === "agents") {
    const present = installedAgents(paths.home);
    return output({
      agents: SKILL_AGENTS.map((agent) => ({
        id: agent.id,
        name: agent.name,
        skills: `~/${skillsFolder(agent)}`,
        found: present.includes(agent.id),
      })),
    });
  }
  if (action === "refresh")
    return output({
      canonical: canonicalSkill(paths.home),
      refreshed: refreshSkill(paths),
      hooks: refreshChosenHooks(paths),
    });
  throw new Error(`Unknown skill action: ${action ?? ""}`);
}

async function chooseAgents(
  args: string[],
  paths: SkillPaths,
): Promise<AgentId[] | null> {
  const present = installedAgents(paths.home);
  // Every agent found here, not every one known: no folders for absent ones.
  if (args.includes("--all"))
    return present.length ? present : (["claude"] as AgentId[]);
  const list = flag(args, "--agents");
  if (list) return parseAgents(list);
  const remembered = rememberedAgents(paths.choiceFile);
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const preselected =
      remembered ?? (present.length ? present : (["claude"] as AgentId[]));
    // The ones on this machine first.
    const agents = [
      ...SKILL_AGENTS.filter((agent) => present.includes(agent.id)),
      ...SKILL_AGENTS.filter((agent) => !present.includes(agent.id)),
    ];
    return checkbox(
      "Install the interviewer skill for which agents?",
      agents.map((agent) => ({
        value: agent.id,
        label: `${agent.name} (~/${skillsFolder(agent)})`,
        checked: preselected.includes(agent.id),
      })),
    );
  }
  if (remembered) return remembered;
  process.stderr.write(
    "Installing for Claude Code only. Run `kim skill install` in a terminal to choose, or pass --agents claude,codex,cursor (see `kim skill agents`) or --all for every agent found here.\n",
  );
  return ["claude"];
}

/** Where kim records the hooks it installed, and the agents opted out. */
const hooksStateFile = () => configFile("hooks-install.json");

/**
 * Keeps the hooks current for the agents chosen for the skill that have
 * them (Claude Code, Codex), unless opted out, as the skill copy is kept
 * current. Never throws.
 */
function refreshChosenHooks(paths: SkillPaths) {
  try {
    const agents = (rememberedAgents(paths.choiceFile) ?? []).filter(
      isHookAgent,
    );
    return refreshHooks(agents, paths.home, hooksStateFile());
  } catch {
    return [];
  }
}

/** In a terminal, says which hooks `skill install` installed, and how to opt out. */
function noteHooks(hooks: HookRefreshResult[]) {
  if (!process.stderr.isTTY) return;
  const names = (filter: (hook: HookRefreshResult) => boolean) =>
    hooks
      .filter(filter)
      .map((hook) => HOOK_AGENTS.find((agent) => agent.id === hook.agent)!.name)
      .join(" and ");
  const installed = names((hook) => "events" in hook);
  if (installed)
    process.stderr.write(
      `Hooks installed for ${installed}, so answers reach it while it works (kim hooks uninstall to opt out).\n`,
    );
  const optedOut = names((hook) => "optedOut" in hook);
  if (optedOut)
    process.stderr.write(
      `No hooks for ${optedOut}: you opted out (kim hooks install to opt back in).\n`,
    );
}

/**
 * `hooks install` adds `kim hook` to the agents' hooks (Claude Code's
 * settings.json, Codex's hooks.json): --agents claude,codex, else those
 * found here, else Claude Code. `hooks uninstall` removes only those
 * entries; `hooks status` says which events have them.
 */
async function hooksCommand(action: string | undefined, args: string[]) {
  const home = homedir();
  if (action === "install") {
    const list = flag(args, "--agents");
    const agents = list
      ? parseAgents(list).filter(isHookAgent)
      : HOOK_AGENTS.filter((agent) =>
          existsSync(dirname(agent.file(home, process.env))),
        ).map((agent) => agent.id);
    if (list && !agents.length)
      throw new Error("Only Claude Code and Codex have hooks kim can use");
    const chosen: HookAgentId[] = agents.length ? agents : ["claude"];
    setHooksOptOut(hooksStateFile(), chosen, false);
    const hooks = refreshHooks(chosen, home, hooksStateFile(), {
      force: true,
    });
    output({ hooks });
    if (hooks.some((hook) => "error" in hook)) process.exitCode = 1;
    return;
  }
  if (action === "uninstall") {
    const hooks = HOOK_AGENTS.map((agent) => uninstallHooks(agent.id, home));
    // So the runs that keep the hooks current don't put them back.
    setHooksOptOut(
      hooksStateFile(),
      HOOK_AGENTS.map((agent) => agent.id),
      true,
    );
    forgetInstalledHooks(
      hooksStateFile(),
      hooks.map((hook) => hook.file),
    );
    return output({ hooks });
  }
  if (action === "status")
    return output({
      hooks: HOOK_AGENTS.map((agent) => hooksStatus(agent.id, home)),
    });
  throw new Error(`Unknown hooks action: ${action ?? ""}`);
}

/** The whole budget a hook has, network included. */
const HOOK_BUDGET_MS = 2_000;
const TAKE_TIMEOUT_MS = 1_500;

/**
 * `hook <event>`: reads the agent's hook payload on stdin and prints the
 * hook's JSON response, the answers as context or `{}`. Whatever happens it
 * prints something, exits 0, and is done within the budget.
 */
async function hookCommand(argument: string | undefined) {
  if (argument === "stop")
    return stopHookCommand(process.argv.includes("--hold"));
  if (argument === "session-end") return sessionEndHookCommand();
  let response: Record<string, unknown> = {};
  try {
    const event = hookEventFor(argument ?? "");
    if (event)
      response = await Promise.race([
        (async () => {
          const payload = JSON.parse(
            (await readStdin()).trim() || "{}",
          ) as HookPayload;
          // The user took the turn: a background Stop hook still waiting
          // gives up, so this turn's own hooks bring the answers in.
          if (event === "UserPromptSubmit")
            disarmWaiter(waitersDir(), payload.session_id ?? "");
          return runHook(event, payload, {
            stateFile: configFile("hooks.json"),
            take: (id, binding) =>
              binding.inbox ? takeInbox(id) : takeAnswers(id),
          });
        })().catch(() => ({})),
        new Promise<Record<string, unknown>>((resolve) =>
          setTimeout(() => resolve({}), HOOK_BUDGET_MS),
        ),
      ]);
  } catch {
    // The agent's work matters more than the answers.
  }
  try {
    checkForUpdateFromHook();
  } catch {
    // Likewise.
  }
  process.stdout.write(`${JSON.stringify(response)}\n`, () => process.exit(0));
}

const waitersDir = () => configFile("waiters");
/** The background waiter wakes the model this long before its hook's timeout. */
const STOP_WAIT_MARGIN_MS = 15 * 60_000;
/** Codex's hold hands back this long before its hook's timeout. */
const STOP_HOLD_MARGIN_MS = 2 * 60_000;
/** How often a background waiter checks it's still the session's newest. */
const WAITER_CHECK_MS = 2_000;

/**
 * `kim hook stop`: the agent is ending its turn. While the session's
 * interview is live it waits for the user: in Claude Code in the
 * background (asyncRewake), waking the model with the answers on stderr
 * and exit code 2; in Codex (`--hold`) by holding the stop and handing the
 * answers back as `decision: block`. Anything going wrong lets it stop.
 */
async function stopHookCommand(hold: boolean) {
  let text: string | null = null;
  try {
    const payload = JSON.parse(
      (await readStdin()).trim() || "{}",
    ) as HookPayload;
    const sessionId = payload.session_id ?? "";
    const stateFile = configFile("hooks.json");
    if (liveBindings(readBindings(stateFile), sessionId).length) {
      const controller = new AbortController();
      let checker: NodeJS.Timeout | undefined;
      if (!hold) {
        const token = armWaiter(waitersDir(), sessionId);
        checker = setInterval(() => {
          if (!waiterArmed(waitersDir(), sessionId, token)) controller.abort();
        }, WAITER_CHECK_MS);
      }
      try {
        const result = await runStop(payload, {
          stateFile,
          waitMs: hold
            ? STOP_HOLD_TIMEOUT_S * 1000 - STOP_HOLD_MARGIN_MS
            : STOP_WAIT_TIMEOUT_S * 1000 - STOP_WAIT_MARGIN_MS,
          wait: (id, deadline, gathered) =>
            stopWait(
              id,
              deadline,
              AbortSignal.any([controller.signal, gathered]),
            ),
        });
        // Given up for a newer waiter or the user's own prompt: say nothing.
        text = controller.signal.aborted ? null : (result?.text ?? null);
      } finally {
        clearInterval(checker);
      }
    }
  } catch {
    text = null;
  }
  if (hold) {
    const response = text ? { decision: "block", reason: text } : {};
    process.stdout.write(`${JSON.stringify(response)}\n`, () =>
      process.exit(0),
    );
    return;
  }
  if (!text) return process.exit(0);
  process.stderr.write(`${text}\n`, () => process.exit(2));
}

/** One batch for the Stop hook, as `kim wait` gets it, or why there's none. */
async function stopWait(
  id: string,
  deadline: number,
  signal: AbortSignal,
): Promise<StopWaitOutcome> {
  let batch: unknown;
  try {
    await watchSocket(
      `/api/sessions/${encodeURIComponent(id)}/socket`,
      () => ({
        mode: "wait",
        idle: "15000",
        timeout: String(Math.max(0, deadline - Date.now())),
      }),
      (message) => {
        if (message.type !== "batch") return;
        batch = message.batch;
        return "done";
      },
      { signal },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/replaced/i.test(message)) return "replaced";
    if (/not found/i.test(message)) return "gone";
    throw error;
  }
  // A batch that came is delivered, so it goes to the agent even when
  // the wait was cut short.
  if (!batch) return signal.aborted ? "replaced" : null;
  // Delivered now, so a batch that won't open still goes to the agent.
  const opened = await encryption.open(batch).catch(() => batch);
  return { batch: opened as StopWaitBatch };
}
type StopWaitBatch = Extract<StopWaitOutcome, { batch: unknown }>["batch"];

/**
 * `kim hook session-end`: the agent session closed. Its waiter gives up,
 * and the interview's page shows the agent away at once; the interview
 * stays open for the next session.
 */
async function sessionEndHookCommand() {
  try {
    const payload = JSON.parse(
      (await readStdin()).trim() || "{}",
    ) as HookPayload;
    const sessionId = payload.session_id ?? "";
    disarmWaiter(waitersDir(), sessionId);
    await Promise.all(
      liveBindings(readBindings(configFile("hooks.json")), sessionId).map(
        (binding) =>
          authorizedFetch(
            `/api/sessions/${encodeURIComponent(binding.interviewId)}/away`,
            { method: "POST", signal: AbortSignal.timeout(TAKE_TIMEOUT_MS) },
          ).catch(() => null),
      ),
    );
  } catch {
    // Closing the session matters more.
  }
  process.stdout.write("{}\n", () => process.exit(0));
}

/**
 * Links the agent session running this command to an interview it started
 * or resumed. Claude Code and Codex (CODEX_THREAD_ID) both name the session
 * with the id their hooks get as `session_id`.
 */
function bindToAgentSession(id: string) {
  const sessionId =
    process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID;
  if (!sessionId) return;
  try {
    bindSession(configFile("hooks.json"), sessionId, id, process.cwd());
  } catch {
    // The hooks can still bind it from a later command.
  }
}

/** Forgets a stopped or deleted interview, however its id was passed. */
function forgetBinding(id: string) {
  try {
    unbindInterview(configFile("hooks.json"), id);
  } catch {
    // A stale binding finds out from the service.
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** The answers the user has given since the last delivery, without waiting. */
async function takeAnswers(id: string): Promise<TakeOutcome> {
  const response = await authorizedFetch(
    `/api/sessions/${encodeURIComponent(id)}/take`,
    { method: "POST", signal: AbortSignal.timeout(TAKE_TIMEOUT_MS) },
  );
  if (response.status === 404) return "gone";
  if (!response.ok) return null;
  return encryption.open((await response.json()) as TakeOutcome);
}

/** What changed in an interview sent to the user since its agent last looked. */
async function takeInbox(token: string): Promise<TakeOutcome> {
  const response = await authorizedFetch(
    `/api/sessions/inbox/${encodeURIComponent(token)}/take`,
    { method: "POST", signal: AbortSignal.timeout(TAKE_TIMEOUT_MS) },
  );
  // Unassigned or deleted: it is no longer the agent's to follow.
  if (response.status === 403 || response.status === 404) return "gone";
  if (!response.ok) return null;
  return {
    news: await encryption.open({
      ...((await response.json()) as InboxNews),
      id: decodeURIComponent(token),
    }),
  };
}

/** Starts kim updating itself, detached, with its output in update.log. */
function startBackgroundUpdate(args: string[]): string {
  const log = configFile("update.log");
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  try {
    spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "update", "--background", ...args],
      { detached: true, stdio: ["ignore", fd, fd], windowsHide: true },
    ).unref();
  } finally {
    closeSync(fd);
  }
  return log;
}

/**
 * A hook can't wait on the update check, so when one is due it stamps it
 * and leaves the check, and any update, to a detached kim.
 */
function checkForUpdateFromHook() {
  if (!readBuild(join(packageRoot(), "build.json"))) return;
  const stateFile = configFile("update-check.json");
  if (!updateDue(stateFile)) return;
  writeUpdateState(stateFile, { checkedAt: Date.now() });
  startBackgroundUpdate(["--check"]);
}

/**
 * `update --background`, detached from whoever started it: with --check,
 * asks the site for the latest build first; with --build, updates to the
 * build already found. Holds a lock so only one runs, and on failure leaves
 * the usual hint for the next command.
 */
async function backgroundUpdate(args: string[]) {
  const stateFile = configFile("update-check.json");
  const current = readBuild(join(packageRoot(), "build.json"));
  if (!current) return;
  const build = flag(args, "--build");
  const latest = args.includes("--check")
    ? await checkForUpdate({
        base: defaultBase,
        current,
        stateFile,
        force: true,
      })
    : build
      ? { version: current.version, build }
      : null;
  const decision = decideUpdate({
    latest,
    blocked: autoUpdateBlocked(packageRoot()),
    state: readUpdateState(stateFile),
    locked: false,
  });
  if (decision === "hint") return writeUpdateState(stateFile, { hint: true });
  if (decision !== "auto" || !latest) return;
  const lock = configFile("update.lock");
  if (!acquireUpdateLock(lock)) return;
  process.stderr.write(
    `${new Date().toISOString()} updating kim to build ${latest.build}\n`,
  );
  try {
    update();
    writeUpdateState(stateFile, { failedBuild: undefined, hint: undefined });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    writeUpdateState(stateFile, { failedBuild: latest.build, hint: true });
  } finally {
    rmSync(lock, { force: true });
  }
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
 * date, and the hooks of the agents chosen for it; and every six hours look
 * for a newer CLI, updating to it in the background (or, where kim mustn't
 * update itself, hinting on stderr).
 * None of it writes to stdout, holds up the command, or fails it.
 */
function housekeeping(group: string | undefined) {
  if (group !== "skill" && group !== "update") {
    try {
      refreshSkill(skillPaths());
    } catch {
      // The command matters more than the skill copy.
    }
    // `hooks` commands install or remove them themselves.
    if (group !== "hooks") refreshChosenHooks(skillPaths());
  }
  const current = readBuild(join(packageRoot(), "build.json"));
  if (!current || group === "update") return;
  const stateFile = configFile("update-check.json");
  // Owed by a check a hook started, or an update that failed.
  const { hint, failedBuild } = readUpdateState(stateFile);
  if (hint) {
    writeUpdateState(stateFile, { hint: undefined });
    process.stderr.write(
      `${UPDATE_HINT}${failedBuild ? ` (updating automatically failed; see ${configFile("update.log")})` : ""}\n`,
    );
  }
  void checkForUpdate({ base: defaultBase, current, stateFile }).then(
    (latest) => {
      const decision = decideUpdate({
        latest,
        blocked: autoUpdateBlocked(packageRoot()),
        state: readUpdateState(stateFile),
        locked: updateLocked(configFile("update.lock")),
      });
      if (decision === "hint") process.stderr.write(`${UPDATE_HINT}\n`);
      if (decision === "auto" && latest)
        process.stderr.write(
          `kim: updating in the background (log: ${startBackgroundUpdate(["--build", latest.build])})\n`,
        );
    },
  );
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
    ...(previous?.contentKey ? { contentKey: previous.contentKey } : {}),
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
  // The encryption key comes back from the browser wrapped to this one-off
  // key, straight to this loopback server: never through the service.
  const handoff = await newAccountKey();
  const handoffState = randomBytes(16).toString("base64url");
  let finish!: (result: { code?: string; error?: string }) => void;
  const result = new Promise<{ code?: string; error?: string }>((resolve) => {
    finish = resolve;
  });
  let keyArrived!: (wrapped: string | null) => void;
  const keyResult = new Promise<string | null>((resolve) => {
    keyArrived = resolve;
  });
  const page = (status: number, text: string) =>
    `<!doctype html><meta charset="utf-8"><title>kim</title><p style="font:16px system-ui;margin:3rem">${text}</p>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/key") {
      const ok = url.searchParams.get("state") === handoffState;
      response
        .writeHead(ok ? 200 : 400, { "content-type": "text/html" })
        .end(
          page(
            ok ? 200 : 400,
            ok
              ? "Signed in. You can close this tab."
              : "That didn't come from this sign-in. Check the terminal.",
          ),
        );
      if (ok) keyArrived(url.searchParams.get("w"));
      return;
    }
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const ok = url.searchParams.get("state") === state && code !== null;
    if (ok) {
      // On to the page that hands over the encryption key; what follows
      // the # never reaches a server.
      const next = new URL(`${defaultBase}/cli-key`);
      next.hash = new URLSearchParams({
        port: String(port),
        state: handoffState,
        pub: `${handoff.publicKey.x}.${handoff.publicKey.y}`,
      }).toString();
      response.writeHead(302, { location: next.toString() }).end();
    } else
      response
        .writeHead(400, { "content-type": "text/html" })
        .end(page(400, "Sign-in failed. Check the terminal."));
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
    const credentials = credentialsFrom(
      clientId,
      (await response.json()) as TokenResponse,
    );
    writeCredentials(credentials);
    process.stderr.write(
      "Signed in. Finish in your browser to give kim your encryption key (unlock, or set it up), or choose Not now there. Ctrl-C is safe: you stay signed in.\n",
    );
    process.stderr.write(
      `If the browser asks, check it shows this code: ${await handoffCode(handoff.publicKey)}\n`,
    );
    const keyTimeout = setTimeout(() => keyArrived(null), 600_000);
    const wrapped = await keyResult;
    clearTimeout(keyTimeout);
    const { publicKey, fingerprint } = (await rawApi(
      "/api/sessions/kim/account",
    )) as { publicKey: unknown; fingerprint?: string };
    let encryptionState: "on" | "off" | "not given" = publicKey
      ? "not given"
      : "off";
    if (wrapped) {
      const account = await importAccountKey(
        await unwrapWith(handoff.privateKey, wrapped),
      );
      if (account.fingerprint !== fingerprint)
        throw new Error(
          "The browser handed over a key that isn't this account's; run kim login again",
        );
      writeCredentials({
        ...credentials,
        contentKey: encodeContentKey(account),
      });
      encryptionState = "on";
    }
    return output({
      ok: true,
      url: defaultBase,
      encryption: encryptionState,
      ...(encryptionState === "not given"
        ? {
            note: "Your account encrypts interviews, and this CLI didn't get your key, so it can't open them. Run kim login again and unlock in the browser.",
          }
        : {}),
    });
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
  const account = signedIn
    ? ((await rawApi("/api/sessions/kim/account").catch(() => null)) as {
        fingerprint?: string;
      } | null)
    : null;
  const mine = await encryption.accountKey().catch(() => null);
  return output({
    url: defaultBase,
    signedIn,
    ...(account
      ? {
          encryption: account.fingerprint
            ? mine?.fingerprint === account.fingerprint
              ? "on"
              : "on, but this CLI doesn't have your key (run kim login)"
            : "off",
        }
      : {}),
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
  const sets = flags(args, "--set");
  if (sets.length) result.optionValues = optionValuesFromFlags(sets);
  const control = flag(args, "--bind");
  if (control) result.control = control;
  const unit = flag(args, "--unit");
  if (unit !== undefined) result.unit = unit;
  for (const key of ["min", "max", "step", "position"]) {
    const value = flag(args, `--${key}`);
    if (value !== undefined) result[key] = Number(value);
  }
  return result;
}
/**
 * `--set '<option>=<control>=<value>'`, repeated: what choosing an option
 * sets in the question's artifact, e.g. `--set 'Serif=--font-display=Fraunces'`.
 */
function optionValuesFromFlags(
  sets: string[],
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const set of sets) {
    const match = /^(.+?)=((?:--|@|#)[\w-]+)=(.*)$/s.exec(set);
    if (!match)
      throw new Error(
        `--set takes <option>=<control>=<value>, e.g. 'Serif=--font-display=Fraunces'; got "${set}"`,
      );
    const [, option, control, value] = match;
    (result[option!] ??= {})[control!] = value!;
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
  "--hooks",
  "--no-hooks",
  "--background",
  "--check",
  "--skip",
  "--send",
  "--full-page",
]);

/** The arguments that aren't flags or their values. */
function positionals(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]?.startsWith("--")) {
      if (!BOOLEAN_FLAGS.has(args[i]!)) i++;
      continue;
    }
    values.push(args[i]!);
  }
  return values;
}
function positional(args: string[], index: number): string {
  const value = positionals(args)[index];
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
    controls in the --artifact (html): choosing an option sets values, the page applies them live
    [--set '<option>=<control>=<value>']   repeatable; controls are --css-var, @attr (data-kim-attr), #slot (data-kim-text)
    [--bind <--css-var> --unit px --min N --max N]   a number question's slider; [--bind <#slot>] a text question
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
    diagrams: SVG, or HTML; for software, prefer a design
  artifact update <session> <artifact> [--file|--content] [--title] [--description] [--show]
    designs: .dbml (data-model), .d2 (architecture; name.data-flow.d2), .mmd (sequence, state), OpenAPI .yaml (api);
    [--type T] [--keep|--no-keep] [--repo-path .kim/… --base <file> [--base-commit SHA]] compares it with a repo copy
  artifact show <session> <artifact|none>   choose what the workspace shows
  artifact delete <session> <artifact>
  stage open|close <session>   show or hide the workspace column

The repo's .kim/ folder (designs, mockups, design system, plans; run these inside the repo):
  design list   what .kim/ holds, to pull what the conversation needs
  design pull <session> <.kim/ file>… [--keep] [--show] [--title T]   a copy, compared with the repo as it changes
  design keep|drop <session> <artifact>   write it to .kim/ when the interview stops, or not (a badge shows it)
  design write <session> [--dry-run]   write what's kept now; \`session stop\` does this first (--no-write skips)
    a file that changed since the copy is a conflict: nothing is written, and the three versions are saved
  design rebase <session> <artifact> --file <merged>   after merging a conflict: the merge, against the repo as it is now

Interviews sent to you (someone assigned you one; your agent drafts, you send):
  inbox   the interviews sent to you (or a linked account) still open: url, sender, open and drafted counts
  inbox show <interview>   its questions with answers, drafts and threads, the chat, and the workspace
  inbox artifact <interview> <artifact> [--out <file>]   the artifact as its frame serves it
  inbox screenshot <interview> <artifact> [--width N] [--full-page] [--out <file.png>]
    renders an html or svg artifact in Chrome, Edge or Chromium on this machine
    (KIM_BROWSER picks one); saves the PNG and prints its path
  inbox chat <interview> [--question <question>] <text>   message the sender's agent, as you
  inbox wait [<interview>] [--timeout MS]   blocks until a new question, reply, workspace change or interview
  draft <interview> <question> [answer…] [--option <label>]… [--note <text>] [--skip] [--send] | --clear
    a draft answer the user reviews and sends at the url; --send answers now (only when the user said to)
    <interview> is its id or url; <question> its id or number

Cloud sessions (claude.ai/code):
  key create <name> | list | revoke <id|name>   agent keys for cloud environments (KEEP_IT_MOVING_TOKEN)
  cloud setup [--project <key>] [--key-name <name>] [--json]
    creates the project's agent key and prints its cloud environment's network
    access, environment variables and setup script, ready to paste

Setup:
  skill install [--agents claude,codex,cursor | --all] [--force] [--hooks | --no-hooks]
    copy the interviewer skill to ~/.agents/skills and link it into each agent's
    skills folder; asks which agents in a terminal, and remembers the choice.
    --all means every agent found on this machine. It never replaces a link
    or folder it didn't make unless --force. For Claude Code and Codex it
    also installs the hooks, and every run keeps them current, unless
    --no-hooks or \`kim hooks uninstall\` opted out
  skill agents      the agents it can link into, their ids and skills folders
  skill uninstall   remove the links and copy skill install made
  skill refresh     bring the skill copy and hooks up to date (every run does this)
  hooks install [--agents claude,codex] | uninstall | status
    agent hooks that bring answers into the agent's context while it works:
    Claude Code's settings.json (CLAUDE_CONFIG_DIR) and Codex's hooks.json
    (CODEX_HOME) run \`kim hook <event>\`; only those entries are ever changed.
    uninstall opts out, so runs stop reinstalling them; install opts back in
  hook session-start|user-prompt-submit|post-tool-use   what the hooks run
  update   reinstall kim from this site, then refresh the skill. kim does this
    itself in the background when it finds a newer build (checked every six
    hours), unless KEEP_IT_MOVING_NO_AUTO_UPDATE=1 or it is a development link

KEEP_IT_MOVING_URL points at another deployment, such as wrangler dev.
`,
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof ApiError || error instanceof DesignCheckError
        ? error.details
        : {}),
    })}\n`,
  );
  process.exitCode = 1;
});
