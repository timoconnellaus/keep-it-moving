import { createHash } from "node:crypto";
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
  Stop: "stop",
  SessionEnd: "session-end",
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
 * Claude Code's Stop hook runs in the background (asyncRewake) and wakes
 * the model when answers arrive; it gives up a little before this, waking
 * the model once to say it's still waiting, so the next stop re-arms it.
 */
export const STOP_WAIT_TIMEOUT_S = 24 * 60 * 60;
/**
 * Codex can't be woken, so its Stop hook holds the turn open: it waits up
 * to about this long, then hands the model the answers or a "still waiting".
 */
export const STOP_HOLD_TIMEOUT_S = 60 * 60;

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

const command = (event: HookEvent, agent: HookAgentId) =>
  `kim hook ${HOOK_EVENTS[event]}${event === "Stop" && agent === "codex" ? " --hold" : ""}`;
const OURS =
  /^kim hook (session-start|user-prompt-submit|post-tool-use|stop|session-end)( --hold)?$/;

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

/** The matcher group `kim hooks install` adds for an event, for an agent. */
export const hookEntry = (
  event: HookEvent,
  agent: HookAgentId = "claude",
): MatcherGroup => {
  if (event !== "Stop")
    return {
      hooks: [
        {
          type: "command",
          command: command(event, agent),
          timeout: HOOK_TIMEOUT_S,
        },
      ],
    };
  return {
    hooks: [
      agent === "claude"
        ? {
            type: "command",
            command: command(event, agent),
            asyncRewake: true,
            timeout: STOP_WAIT_TIMEOUT_S,
            rewakeMessage: "From your interview:",
            rewakeSummary: "Keep it moving: new answers",
          }
        : {
            type: "command",
            command: command(event, agent),
            timeout: STOP_HOLD_TIMEOUT_S,
            statusMessage: "Waiting for answers in Keep it moving",
          },
    ],
  };
};

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
    hooks[event] = [...(hooks[event] ?? []), hookEntry(event, agent)];
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

/**
 * A hash of the entries kim adds, as the skill copy is hashed: when it
 * differs from the one recorded for a file, that file's entries are
 * rewritten.
 */
export const hooksHash = (agent: HookAgentId = "claude") =>
  createHash("sha256")
    .update(
      JSON.stringify(
        (Object.keys(HOOK_EVENTS) as HookEvent[]).map((event) => [
          event,
          hookEntry(event, agent),
        ]),
      ),
    )
    .digest("hex");

/**
 * What kim remembers about the hooks it keeps current: the agents the user
 * opted out for (`kim hooks uninstall`, `--no-hooks`), and the hash last
 * installed into each hooks file. By file, not agent, because each
 * CLAUDE_CONFIG_DIR has a settings.json of its own.
 */
interface HooksState {
  optedOut?: HookAgentId[];
  installed?: Record<string, string>;
}

function readHooksState(stateFile: string): HooksState {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as unknown;
    return state && typeof state === "object" ? (state as HooksState) : {};
  } catch {
    return {};
  }
}

function writeHooksState(stateFile: string, state: HooksState) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
}

/** Records that the user doesn't want `agents`' hooks, or no longer minds. */
export function setHooksOptOut(
  stateFile: string,
  agents: readonly HookAgentId[],
  optedOut: boolean,
) {
  const state = readHooksState(stateFile);
  const rest = (state.optedOut ?? []).filter((id) => !agents.includes(id));
  const next = optedOut ? [...rest, ...agents] : rest;
  if (JSON.stringify(next) === JSON.stringify(state.optedOut ?? [])) return;
  writeHooksState(stateFile, { ...state, optedOut: next });
}

/** Forgets what was installed into `files`, as `kim hooks uninstall` removes it. */
export function forgetInstalledHooks(stateFile: string, files: string[]) {
  const state = readHooksState(stateFile);
  if (!files.some((file) => state.installed?.[file])) return;
  writeHooksState(stateFile, {
    ...state,
    installed: Object.fromEntries(
      Object.entries(state.installed ?? {}).filter(
        ([file]) => !files.includes(file),
      ),
    ),
  });
}

export type HookRefreshResult =
  | HookFileResult
  | { agent: HookAgentId; file: string; optedOut: true }
  | { agent: HookAgentId; file: string; error: string };

/** Whether a hooks file still has our entry for every event. */
function hooksPresent(file: string): boolean {
  try {
    const events = installedEvents(readHooksFile(file).settings);
    return events.length === Object.keys(HOOK_EVENTS).length;
  } catch {
    // Unreadable: installing reports why.
    return false;
  }
}

/**
 * Installs the hooks for each of `agents` the user hasn't opted out for,
 * when the file's recorded hash isn't the current one, or the file has lost
 * them (always, with `force`): something else can rewrite it, as Orca does
 * a Claude profile's settings. Cheap enough for every run: when they're
 * current it's the state file and the hooks file read. A file it can't read
 * or write is left as it is and reported, never thrown, and tried again
 * next time.
 */
export function refreshHooks(
  agents: readonly HookAgentId[],
  home: string,
  stateFile: string,
  { env = process.env, force = false } = {},
): HookRefreshResult[] {
  const state = readHooksState(stateFile);
  const installed = { ...state.installed };
  const results = agents.flatMap((agent): HookRefreshResult[] => {
    const hash = hooksHash(agent);
    const file = agentFile(agent, home, env);
    if (state.optedOut?.includes(agent))
      return [{ agent, file, optedOut: true }];
    if (!force && installed[file] === hash && hooksPresent(file)) return [];
    try {
      const result = installHooks(agent, home, env);
      installed[file] = hash;
      return [result];
    } catch (error) {
      return [
        {
          agent,
          file,
          error: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  });
  if (JSON.stringify(installed) !== JSON.stringify(state.installed ?? {}))
    writeHooksState(stateFile, { ...state, installed });
  return results;
}
