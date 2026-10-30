import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Agent hooks that bring an interview's answers into the agent's context
 * while it works, between `kim wait`s: each runs `kim hook <event>`. They
 * go in the agent's own hooks file, beside whatever else is there, and only
 * the entries that run `kim hook` are ever changed or removed.
 */

/** The agent's hook events, and the `kim hook` argument for each. */
export const HOOK_EVENTS = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PostToolUse: "post-tool-use",
} as const;
export type HookEvent = keyof typeof HOOK_EVENTS;
export type HookArgument = (typeof HOOK_EVENTS)[HookEvent];

export const hookEventFor = (argument: string): HookEvent | null =>
  (Object.keys(HOOK_EVENTS) as HookEvent[]).find(
    (event) => HOOK_EVENTS[event] === argument,
  ) ?? null;

/** Seconds the agent gives a hook; `kim hook` itself gives up after two. */
const HOOK_TIMEOUT_S = 5;

/**
 * The agents whose hooks can add to the model's context on these events.
 * Claude Code keeps them in settings.json (under CLAUDE_CONFIG_DIR when
 * set), Codex in hooks.json (under CODEX_HOME); both use the same shape.
 * Codex runs a new hook only once the user trusts it in `/hooks`.
 */
export const HOOK_AGENTS = [
  {
    id: "claude",
    name: "Claude Code",
    file: (home: string, env: NodeJS.ProcessEnv) =>
      join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json"),
  },
  {
    id: "codex",
    name: "Codex",
    file: (home: string, env: NodeJS.ProcessEnv) =>
      join(env.CODEX_HOME || join(home, ".codex"), "hooks.json"),
  },
] as const;
export type HookAgentId = (typeof HOOK_AGENTS)[number]["id"];

export const isHookAgent = (id: string): id is HookAgentId =>
  HOOK_AGENTS.some((agent) => agent.id === id);

const command = (event: HookEvent) => `kim hook ${HOOK_EVENTS[event]}`;
const OURS = /^kim hook (session-start|user-prompt-submit|post-tool-use)$/;

interface Handler {
  type?: string;
  command?: unknown;
  [key: string]: unknown;
}
interface MatcherGroup {
  matcher?: string;
  hooks?: Handler[];
  [key: string]: unknown;
}
type HooksFile = Record<string, unknown> & {
  hooks?: Record<string, MatcherGroup[]>;
};

/** The matcher group `kim hooks install` adds for an event. */
export const hookEntry = (event: HookEvent): MatcherGroup => ({
  hooks: [
    { type: "command", command: command(event), timeout: HOOK_TIMEOUT_S },
  ],
});

const ours = (handler: Handler) =>
  typeof handler.command === "string" && OURS.test(handler.command.trim());

/** The file's settings and its indent, or a clear error rather than a guess. */
function readHooksFile(file: string): { settings: HooksFile; indent: string } {
  if (!existsSync(file)) return { settings: {}, indent: "  " };
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return { settings: {}, indent: "  " };
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new Error(`${file} isn't valid JSON; fix it, then try again`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error(`${file} isn't a JSON object; fix it, then try again`);
  const hooks = (settings as HooksFile).hooks;
  if (
    hooks !== undefined &&
    (typeof hooks !== "object" || Array.isArray(hooks))
  )
    throw new Error(`${file} has a "hooks" that isn't an object`);
  return {
    settings: settings as HooksFile,
    indent: /^[ \t]+(?=")/m.exec(text)?.[0] ?? "  ",
  };
}

function writeHooksFile(file: string, settings: HooksFile, indent: string) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, indent)}\n`);
  renameSync(temporary, file);
}

/** `settings` without our handlers, dropping groups and events left empty. */
function withoutOurs(settings: HooksFile): HooksFile {
  if (!settings.hooks) return settings;
  const hooks: Record<string, MatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups.flatMap((group) => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(ours))
        return [group];
      const rest = group.hooks.filter((handler) => !ours(handler));
      return rest.length ? [{ ...group, hooks: rest }] : [];
    });
    if (kept.length) hooks[event] = kept;
  }
  // In place, so the file's keys keep their order.
  return Object.keys(hooks).length
    ? { ...settings, hooks }
    : Object.fromEntries(
        Object.entries(settings).filter(([key]) => key !== "hooks"),
      );
}

/** The events that already run `kim hook`. */
function installedEvents(settings: HooksFile): HookEvent[] {
  return (Object.keys(HOOK_EVENTS) as HookEvent[]).filter((event) => {
    const groups = settings.hooks?.[event];
    return (
      Array.isArray(groups) &&
      groups.some(
        (group) => Array.isArray(group?.hooks) && group.hooks.some(ours),
      )
    );
  });
}

export interface HookFileResult {
  agent: HookAgentId;
  file: string;
  changed: boolean;
  events: HookEvent[];
}

const agentFile = (agent: HookAgentId, home: string, env: NodeJS.ProcessEnv) =>
  HOOK_AGENTS.find((known) => known.id === agent)!.file(home, env);

/**
 * Adds our entry for each event, replacing any earlier one of ours, and
 * leaves the file untouched when it already has exactly these.
 */
export function installHooks(
  agent: HookAgentId,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): HookFileResult {
  const file = agentFile(agent, home, env);
  const { settings, indent } = readHooksFile(file);
  const cleaned = withoutOurs(settings);
  const hooks = { ...cleaned.hooks };
  for (const event of Object.keys(HOOK_EVENTS) as HookEvent[])
    hooks[event] = [...(hooks[event] ?? []), hookEntry(event)];
  const next = { ...cleaned, hooks };
  const changed =
    JSON.stringify(next) !== JSON.stringify(settings) || !existsSync(file);
  if (changed) writeHooksFile(file, next, indent);
  return { agent, file, changed, events: installedEvents(next) };
}

/** Removes our entries, and nothing else. */
export function uninstallHooks(
  agent: HookAgentId,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): HookFileResult {
  const file = agentFile(agent, home, env);
  if (!existsSync(file)) return { agent, file, changed: false, events: [] };
  const { settings, indent } = readHooksFile(file);
  const next = withoutOurs(settings);
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  if (changed) writeHooksFile(file, next, indent);
  return { agent, file, changed, events: [] };
}

export function hooksStatus(
  agent: HookAgentId,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): { agent: HookAgentId; file: string; events: HookEvent[]; error?: string } {
  const file = agentFile(agent, home, env);
  try {
    return {
      agent,
      file,
      events: installedEvents(readHooksFile(file).settings),
    };
  } catch (error) {
    return {
      agent,
      file,
      events: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
