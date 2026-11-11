import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { HookEvent } from "./hooks.js";

/**
 * `kim hook <event>`: what an agent's hook runs. It remembers which
 * interviews each agent session works on, from the kim commands the agent
 * runs, and between the agent's steps takes any answers the user has given
 * since, so they reach the agent while it works instead of waiting for its
 * next `kim wait`. Interviews sent to the user (`kim inbox`, `kim draft`)
 * bind too, and bring what the sender's side changed: new questions, its
 * agent's replies, workspace changes. It must never hold the agent up: a
 * session with no interviews costs one small file read.
 */

/** An interview an agent session is working on. */
export interface Binding {
  interviewId: string;
  agentSessionId: string;
  cwd: string;
  boundAt: number;
  /** When a hook last took this interview's answers. */
  takenAt?: number;
  /** Sent to the user: interviewId is its token, and changes come from the inbox. */
  inbox?: true;
  /**
   * When its agent session ended. The interview stays bound so the next
   * session can carry on, but any session may now take it just by working
   * on it; until then only starting or resuming it takes it over.
   */
  endedAt?: number;
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

/** What `kim inbox wait` prints for one interview, as a take returns it. */
export interface InboxNews {
  /** Whether anything in it is new. */
  news: boolean;
  status?: string;
  [key: string]: unknown;
}

/**
 * What a take found: a batch (maybe empty), an interview sent to the user's
 * news, the interview gone, or no answer in time.
 */
export type TakeOutcome =
  { batch: Batch } | { news: InboxNews } | "gone" | null;

/** At most one take per interview this often between tool calls. */
export const TAKE_THROTTLE_MS = 15_000;
/** A binding no command has renewed for this long is forgotten. */
export const BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Claude Code shows at most 10,000 characters of a hook's context. */
const CONTEXT_MAX = 9_500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An interview sent to the user, by its token or its page's URL. */
const SENT = /^(?:https?:\/\/[^\s]*\/s\/)?([A-Za-z0-9_-]{32})$/;
/** Inbox commands that name the interview first. */
const INBOX_ACTIONS = new Set([
  "show",
  "artifact",
  "screenshot",
  "chat",
  "wait",
]);
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
  /** Interviews sent to the user that the command worked on, by token. */
  inbox: string[];
  /** Interviews the command started or resumed, which the session moves to. */
  started?: string[];
} {
  const bind: string[] = [];
  const unbind: string[] = [];
  const inbox: string[] = [];
  const started: string[] = [];
  const raw = payload.tool_input?.command;
  const command = Array.isArray(raw) ? raw.join(" ") : raw;
  if (typeof command !== "string") return { bind, unbind, inbox };
  const invocations = kimInvocations(command);
  if (!invocations.length) return { bind, unbind, inbox };
  let printsSession = false;
  let startsNew = false;
  for (const [group, action, ...rest] of invocations) {
    const sent =
      group === "draft"
        ? action
        : group === "inbox" && INBOX_ACTIONS.has(action!)
          ? rest[0]
          : undefined;
    if (group === "draft" || group === "inbox") {
      const token = sent && SENT.exec(sent)?.[1];
      if (token) inbox.push(token);
      continue;
    }
    const ids = [action, ...rest].filter(
      (word): word is string => word !== undefined && UUID.test(word),
    );
    if (group === "session" && (action === "stop" || action === "delete"))
      unbind.push(...ids);
    else if (ids[0]) bind.push(ids[0]);
    if (group === "session" && action === "resume" && ids[0])
      started.push(ids[0]);
    if (group === "session" && ["create", "resume", "show"].includes(action!))
      printsSession = true;
    if (group === "ask" || (group === "session" && action === "create"))
      startsNew = true;
  }
  for (const line of responseText(payload.tool_response).split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as { interviewId?: unknown; id?: unknown };
      const id =
        typeof value.interviewId === "string" && UUID.test(value.interviewId)
          ? value.interviewId
          : printsSession && typeof value.id === "string" && UUID.test(value.id)
            ? value.id
            : null;
      if (!id) continue;
      bind.push(id);
      if (startsNew) started.push(id);
    } catch {
      // Not kim's JSON.
    }
  }
  const kept = (ids: string[]) =>
    [...new Set(ids)].filter((id) => !unbind.includes(id));
  return {
    bind: kept(bind),
    unbind: [...new Set(unbind)],
    inbox: [...new Set(inbox)],
    ...(kept(started).length ? { started: kept(started) } : {}),
  };
}

const ARRIVED: Record<HookEvent, string> = {
  PostToolUse: "arrived while you were working",
  UserPromptSubmit: "arrived since you last checked",
  SessionStart: "arrived while no session was watching",
  Stop: "arrived while you were waiting",
  SessionEnd: "arrived as the session ended",
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

/** An interview sent to the user's news, as the agent reads it. */
export function formatNews(
  event: HookEvent,
  token: string,
  news: InboxNews,
): string {
  const intro = `Keep it moving: changes to interview ${token}, which was sent to your user, ${ARRIVED[event]}. Act on them exactly as on \`kim inbox wait\` output.`;
  const json = JSON.stringify(news);
  return `${intro}\n${json.length > CONTEXT_MAX ? `${json.slice(0, CONTEXT_MAX)}… (cut short; run \`kim inbox show ${token}\`)` : json}`;
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
    take: (interviewId: string, binding: Binding) => Promise<TakeOutcome>;
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
    const changes = bindingChanges(payload);
    const { unbind, inbox } = changes;
    // A session can work on several interviews of the user's own. Starting
    // or resuming one adds it; other commands renew the ones it has, or
    // bind the first, so looking at an old interview doesn't add it. Only
    // starting or resuming takes one another live session is running: a
    // command that just names it (listing, screenshotting) would otherwise
    // take its answers away from the agent asking the questions.
    const own = new Set(
      liveBindings(bindings, sessionId).map((binding) => binding.interviewId),
    );
    const heldElsewhere = new Set(
      bindings
        .filter(
          (binding) =>
            !binding.inbox &&
            binding.agentSessionId !== sessionId &&
            binding.endedAt === undefined,
        )
        .map((binding) => binding.interviewId),
    );
    const bind = [
      ...new Set([
        ...(changes.started ?? []),
        ...changes.bind.filter((id) => own.has(id)),
        ...(!own.size && !changes.started?.length
          ? changes.bind.filter((id) => !heldElsewhere.has(id)).slice(-1)
          : []),
      ]),
    ];
    if (bind.length || unbind.length || inbox.length) {
      changed = true;
      const touched = new Set([...bind, ...unbind, ...inbox]);
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
        ...inbox.map((interviewId) => ({
          interviewId,
          agentSessionId: sessionId,
          cwd,
          boundAt: now,
          inbox: true as const,
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
        // The session's own interview at every step; one sent to the user,
        // whose changes are rarely urgent, at most every 15 s.
        (event === "UserPromptSubmit" ||
          !binding.inbox ||
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
      outcome: await deps.take(target.interviewId, target).catch(() => null),
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
    if ("news" in outcome) {
      if (outcome.news.status === "stopped") finished.add(interviewId);
      if (outcome.news.news)
        parts.push(formatNews(event, interviewId, outcome.news));
      continue;
    }
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

/** The interviews of the user's own that an agent session is on, oldest first. */
export const liveBindings = (
  bindings: Binding[],
  sessionId: string,
): Binding[] =>
  sessionId
    ? bindings.filter(
        (binding) => !binding.inbox && binding.agentSessionId === sessionId,
      )
    : [];

/**
 * Links an agent session to an interview it just started or resumed, from
 * kim itself, alongside any others it's on. The PostToolUse hook only sees what the command printed, and
 * an agent often keeps that in a variable (`S=$(kim session create …)`).
 */
export function bindSession(
  file: string,
  sessionId: string,
  interviewId: string,
  cwd: string,
  now = Date.now(),
): void {
  writeBindings(file, [
    ...readBindings(file).filter(
      (binding) => binding.interviewId !== interviewId,
    ),
    { interviewId, agentSessionId: sessionId, cwd, boundAt: now },
  ]);
}

/**
 * Marks an agent session's interviews as left by it, so the next session
 * can pick them up by working on them.
 */
export function endSession(
  file: string,
  sessionId: string,
  now = Date.now(),
): void {
  const bindings = readBindings(file);
  if (!bindings.some((binding) => binding.agentSessionId === sessionId)) return;
  writeBindings(
    file,
    bindings.map((binding) =>
      binding.agentSessionId === sessionId
        ? { ...binding, endedAt: now }
        : binding,
    ),
  );
}

/** Forgets an interview that was stopped or deleted, whoever it was bound to. */
export function unbindInterview(file: string, interviewId: string): void {
  const bindings = readBindings(file);
  const kept = bindings.filter((known) => known.interviewId !== interviewId);
  if (kept.length !== bindings.length) writeBindings(file, kept);
}

/** What a wait for the Stop hook found. */
export type StopWaitOutcome =
  | { batch: Batch }
  | "gone"
  | "replaced"
  /** The deadline passed with nothing from the user. */
  | null;

/** Whether a batch has anything from the user, not only the agent's own edits. */
const fromUser = (batch: Batch) =>
  Boolean(
    (Array.isArray(batch.answers) && batch.answers.length) ||
    (Array.isArray(batch.messages) && batch.messages.length),
  );

/** After the first interview's answers, how long the others get to send theirs too. */
export const STOP_GATHER_MS = 300;

/**
 * What the Stop hook does: Claude Code's waits in the background and wakes
 * the model (`wake`), Codex's holds the turn open and hands the model the
 * answers as its next prompt (`block`). It waits on every live interview
 * the session is on at once, and the first to bring something from the
 * user ends the wait, with whatever the others brought by then. Either way
 * the agent can't leave a live interview behind: only stopping it ends the
 * waiting. `null` lets the agent stop: there's no interview, they all
 * ended, or a newer waiter took over.
 */
export async function runStop(
  payload: HookPayload,
  deps: {
    stateFile: string;
    /**
     * Waits until `deadline` for a batch, as `kim wait` does. `signal`
     * ends it early, once another interview's answers came; a batch it
     * already has must still be returned then.
     */
    wait: (
      interviewId: string,
      deadline: number,
      signal: AbortSignal,
    ) => Promise<StopWaitOutcome>;
    /** How long to wait before saying "still waiting". */
    waitMs: number;
    now?: number;
    /** The time, to tell a wait that ran its course from one cut short. */
    clock?: () => number;
    gatherMs?: number;
  },
): Promise<{ text: string } | null> {
  const now = deps.now ?? Date.now();
  const clock = deps.clock ?? Date.now;
  const live = liveBindings(
    readBindings(deps.stateFile),
    payload.session_id ?? "",
  );
  if (!live.length) return null;
  const started = clock();
  const gathered = new AbortController();
  let gathering: ReturnType<typeof setTimeout> | undefined;
  // A refusal (the Free plan's limit, signed out) drops that interview: waking
  // the model to say "still waiting" would only fail the same way again.
  const outcomes = await Promise.all(
    live.map(async ({ interviewId }) => {
      const outcome = await deps
        .wait(interviewId, now + deps.waitMs, gathered.signal)
        .catch((): StopWaitOutcome | "failed" => "failed");
      if (
        outcome &&
        typeof outcome === "object" &&
        fromUser(outcome.batch) &&
        outcome.batch.status !== "stopped"
      )
        gathering ??= setTimeout(
          () => gathered.abort(),
          deps.gatherMs ?? STOP_GATHER_MS,
        );
      return { interviewId, outcome };
    }),
  );
  clearTimeout(gathering);
  const ended = new Set(
    outcomes
      .filter(
        ({ outcome }) =>
          outcome === "gone" ||
          (outcome &&
            typeof outcome === "object" &&
            outcome.batch.status === "stopped"),
      )
      .map(({ interviewId }) => interviewId),
  );
  if (ended.size)
    writeBindings(
      deps.stateFile,
      readBindings(deps.stateFile).filter(
        (known) => !ended.has(known.interviewId),
      ),
    );
  const answered = outcomes.flatMap(({ interviewId, outcome }) =>
    outcome &&
    typeof outcome === "object" &&
    !ended.has(interviewId) &&
    fromUser(outcome.batch)
      ? [formatBatch("Stop", interviewId, outcome.batch)]
      : [],
  );
  if (answered.length) return { text: answered.join("\n\n") };
  // Nothing from the user. Only a wait that ran its course says so, so a
  // wait that ends early for any reason can't wake the model over and over.
  const waiting = outcomes.filter(
    ({ interviewId, outcome }) =>
      !ended.has(interviewId) && outcome !== "failed" && outcome !== "replaced",
  );
  if (!waiting.length || clock() - started < deps.waitMs / 2) return null;
  const ids = waiting.map(({ interviewId }) => interviewId);
  const [only] = ids;
  const text =
    ids.length === 1
      ? `interview ${only} is still running and nothing new has arrived. If you have nothing else to do, end your turn again to keep waiting; when the interview is done, stop it with \`kim session stop ${only}\`.`
      : `interviews ${ids.join(", ")} are still running and nothing new has arrived. If you have nothing else to do, end your turn again to keep waiting; when one is done, stop it with \`kim session stop <id>\`.`;
  return { text: `Keep it moving: ${text}` };
}

/**
 * The background Stop hook's claim on an agent session: a file holding the
 * newest waiter's token. A newer stop replaces it, and the user's prompt or
 * the session's end removes it; a waiter whose token is gone gives up.
 */
const waiterFile = (dir: string, sessionId: string) =>
  join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.waiter`);

export function armWaiter(dir: string, sessionId: string): string {
  const token = randomBytes(8).toString("hex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(waiterFile(dir, sessionId), token);
  return token;
}

export function waiterArmed(
  dir: string,
  sessionId: string,
  token: string,
): boolean {
  try {
    return readFileSync(waiterFile(dir, sessionId), "utf8") === token;
  } catch {
    return false;
  }
}

export function disarmWaiter(dir: string, sessionId: string): void {
  if (sessionId) rmSync(waiterFile(dir, sessionId), { force: true });
}
