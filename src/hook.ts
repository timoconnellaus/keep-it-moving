import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HookEvent } from "./hooks.js";

/**
 * `kim hook <event>`: what an agent's hook runs. It remembers which
 * interviews each agent session works on, from the kim commands the agent
 * runs, and between the agent's steps takes any answers the user has given
 * since, so they reach the agent while it works instead of waiting for its
 * next `kim wait`. It must never hold the agent up: a session with no
 * interviews costs one small file read.
 */

/** An interview an agent session is working on. */
export interface Binding {
  interviewId: string;
  agentSessionId: string;
  cwd: string;
  boundAt: number;
  /** When a hook last took this interview's answers. */
  takenAt?: number;
}

/** The parts of a hook's stdin payload kim reads; Claude Code and Codex share them. */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: unknown } | null;
  tool_response?: unknown;
}

/** A take's batch, in the shape `kim wait` prints. */
export interface Batch {
  events: unknown[];
  openQuestions?: number;
  status?: string;
  [key: string]: unknown;
}

/** What a take found: a batch (maybe empty), the interview gone, or no answer in time. */
export type TakeOutcome = { batch: Batch } | "gone" | null;

/** At most one take per interview this often between tool calls. */
export const TAKE_THROTTLE_MS = 15_000;
/** A binding no command has renewed for this long is forgotten. */
export const BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Claude Code shows at most 10,000 characters of a hook's context. */
const CONTEXT_MAX = 9_500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIM = /(^|\/)(kim|interviewer)$/;

export function readBindings(file: string): Binding[] {
  try {
    const { bindings } = JSON.parse(readFileSync(file, "utf8")) as {
      bindings?: Binding[];
    };
    return Array.isArray(bindings) ? bindings : [];
  } catch {
    return [];
  }
}

function writeBindings(file: string, bindings: Binding[]) {
  mkdirSync(dirname(file), { recursive: true });
  // Write then rename: hooks for parallel tool calls run at once.
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ bindings })}\n`);
  renameSync(temporary, file);
}

/** Every string in a tool's response, whatever shape the agent gives it. */
function responseText(response: unknown): string {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map(responseText).join("\n");
  if (response && typeof response === "object")
    return Object.values(response).map(responseText).join("\n");
  return "";
}

/** The kim invocations in a shell command, as their arguments. */
function kimInvocations(command: string): string[][] {
  return command
    .split(/\$\(|&&|\|\||[;&|\n()`]/)
    .map((segment) =>
      segment
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/^["']|["']$/g, "")),
    )
    .flatMap((words) => {
      const at = words.findIndex((word) => KIM.test(word));
      return at >= 0 ? [words.slice(at + 1)] : [];
    });
}

/**
 * The interviews a shell command shows the agent working on, and the ones
 * it stopped or deleted: ids in the kim command's arguments, and in what
 * `ask`, `session create` and the like printed.
 */
export function bindingChanges(payload: HookPayload): {
  bind: string[];
  unbind: string[];
} {
  const bind: string[] = [];
  const unbind: string[] = [];
  const raw = payload.tool_input?.command;
  const command = Array.isArray(raw) ? raw.join(" ") : raw;
  if (typeof command !== "string") return { bind, unbind };
  const invocations = kimInvocations(command);
  if (!invocations.length) return { bind, unbind };
  let printsSession = false;
  for (const [group, action, ...rest] of invocations) {
    const ids = [action, ...rest].filter(
      (word): word is string => word !== undefined && UUID.test(word),
    );
    if (group === "session" && (action === "stop" || action === "delete"))
      unbind.push(...ids);
    else if (ids[0]) bind.push(ids[0]);
    if (group === "session" && ["create", "resume", "show"].includes(action!))
      printsSession = true;
  }
  for (const line of responseText(payload.tool_response).split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as { interviewId?: unknown; id?: unknown };
      if (typeof value.interviewId === "string" && UUID.test(value.interviewId))
        bind.push(value.interviewId);
      else if (
        printsSession &&
        typeof value.id === "string" &&
        UUID.test(value.id)
      )
        bind.push(value.id);
    } catch {
      // Not kim's JSON.
    }
  }
  return {
    bind: [...new Set(bind)].filter((id) => !unbind.includes(id)),
    unbind: [...new Set(unbind)],
  };
}

const ARRIVED: Record<HookEvent, string> = {
  PostToolUse: "arrived while you were working",
  UserPromptSubmit: "arrived since you last checked",
  SessionStart: "arrived while no session was watching",
};

/** A batch as the agent reads it: `kim wait`'s JSON, after one line saying where it came from. */
export function formatBatch(
  event: HookEvent,
  interviewId: string,
  batch: Batch,
): string {
  const intro = `Keep it moving: answers to interview ${interviewId} ${ARRIVED[event]}. Act on them exactly as on \`kim wait\` output.`;
  let json = JSON.stringify({ interviewId, ...batch });
  // The answers and messages matter; the raw events can go.
  if (json.length > CONTEXT_MAX) {
    const { events, ...rest } = batch;
    json = JSON.stringify({
      interviewId,
      ...rest,
      events: `${events.length} events omitted; the answers and messages above are what changed`,
    });
  }
  return `${intro}\n${json}`;
}

/**
 * Runs one hook event against the bindings in `stateFile`, taking answers
 * through `take`, and returns the hook's JSON response: `{}`, or the
 * answers as additional context.
 */
export async function runHook(
  event: HookEvent,
  payload: HookPayload,
  deps: {
    stateFile: string;
    take: (interviewId: string) => Promise<TakeOutcome>;
    now?: number;
  },
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now();
  const sessionId = payload.session_id ?? "";
  const cwd = payload.cwd ?? "";
  const before = readBindings(deps.stateFile);
  let bindings = before.filter(
    (binding) => now - binding.boundAt < BINDING_TTL_MS,
  );
  let changed = bindings.length !== before.length;

  if (event === "PostToolUse") {
    const { bind, unbind } = bindingChanges(payload);
    if (bind.length || unbind.length) {
      changed = true;
      const touched = new Set([...bind, ...unbind]);
      const previous = new Map(
        bindings.map((binding) => [binding.interviewId, binding]),
      );
      bindings = [
        ...bindings.filter((binding) => !touched.has(binding.interviewId)),
        ...bind.map((interviewId) => ({
          interviewId,
          agentSessionId: sessionId,
          cwd,
          boundAt: now,
          ...(previous.get(interviewId)?.takenAt !== undefined
            ? { takenAt: previous.get(interviewId)!.takenAt }
            : {}),
        })),
      ];
    }
  }

  const targets = bindings.filter((binding) =>
    event === "SessionStart"
      ? binding.cwd === cwd
      : binding.agentSessionId === sessionId &&
        (event === "UserPromptSubmit" ||
          now - (binding.takenAt ?? 0) >= TAKE_THROTTLE_MS),
  );
  if (!targets.length) {
    if (changed) writeBindings(deps.stateFile, bindings);
    return {};
  }
  for (const target of targets) target.takenAt = now;
  writeBindings(deps.stateFile, bindings);

  const outcomes = await Promise.all(
    targets.map(async (target) => ({
      interviewId: target.interviewId,
      outcome: await deps.take(target.interviewId).catch(() => null),
    })),
  );
  const finished = new Set<string>();
  const parts: string[] = [];
  for (const { interviewId, outcome } of outcomes) {
    if (outcome === "gone") {
      finished.add(interviewId);
      continue;
    }
    if (!outcome) continue;
    if (outcome.batch.status === "stopped") finished.add(interviewId);
    if (outcome.batch.events.length)
      parts.push(formatBatch(event, interviewId, outcome.batch));
  }
  if (finished.size) {
    const current = readBindings(deps.stateFile);
    writeBindings(
      deps.stateFile,
      current.filter((binding) => !finished.has(binding.interviewId)),
    );
  }
  return parts.length
    ? {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: parts.join("\n\n"),
        },
      }
    : {};
}
