import { Hono, type Context } from "hono";
import { defaultAnswerText } from "../shared/answers.js";
import type { ProjectStats } from "../shared/inbox.js";
import type {
  ArtifactView,
  InterviewEvent,
  SessionView,
} from "../shared/schema.js";
import { ARTIFACT_VIEW_HEADERS } from "./artifactView.js";
import { allFeatures, type Feature } from "./features/index.js";
import { VIA_KEY_HEADER } from "./features/keys.js";
import type { Sql } from "./sql.js";
import type { InterviewStore } from "./store.js";

/** Where browser state updates go: hibernating WebSockets in production. */
export interface BrowserSockets {
  send(sessionId: string, data: string): void;
  /** Every open page, whichever interview it shows. */
  sendAll(data: string): void;
}

/** Sends a data-less Web Push; resolves to the push service's HTTP status. */
export type PushSender = (endpoint: string) => Promise<number>;

export interface HubOptions {
  store: InterviewStore;
  /** The store's database, for Keep it moving features' own tables. */
  sql: Sql;
  /** Worker secrets the features use. */
  env?: { githubToken?: string | undefined };
  /** The public origin, used in session URLs. */
  baseUrl: string;
  sockets: BrowserSockets;
  /** Web Push to the user's devices; absent when no VAPID key is configured. */
  push?: { publicKey: string; send: PushSender } | undefined;
}

interface Watcher {
  write: (event: InterviewEvent) => boolean;
  /** A newer watcher took over: end without marking anything delivered. */
  replace: () => void;
}

/**
 * The newest watcher wins. A client that died without the server noticing
 * (a killed CLI whose disconnect never reached the Durable Object) would
 * otherwise hold the lease until its request timed out.
 */
const REPLACED = "Replaced by a newer watcher on this interview";

/** The interview API: agent routes under /api/sessions, browser routes under /api/browser/:token. */
export function createHub(options: HubOptions) {
  const { store, baseUrl, sockets } = options;
  const watchers = new Map<string, Watcher>();
  // `kim wait` chains short requests, so an agent counts as watching for a
  // moment after its request ends; the chat says whether anyone will read.
  const watchedUntil = new Map<string, number>();
  const watching = (id: string) =>
    watchers.has(id) || (watchedUntil.get(id) ?? 0) > Date.now();
  const claim = (id: string, watcher: Watcher) => {
    const was = watching(id);
    watchers.get(id)?.replace();
    watchers.set(id, watcher);
    if (!was) later(() => broadcast(id));
  };
  const release = (id: string, watcher: Watcher | null) => {
    if (!watcher || watchers.get(id) !== watcher) return;
    watchers.delete(id);
    watchedUntil.set(id, Date.now() + WATCH_GRACE_MS);
    setTimeout(() => {
      if (!watching(id)) broadcast(id);
    }, WATCH_GRACE_MS + 50);
  };
  const app = new Hono();

  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message)
      ? 404
      : /can't manage keys/i.test(message)
        ? 403
        : /stopped|replaced by a newer watcher/i.test(message)
          ? 409
          : 400;
    return c.json({ error: message }, status);
  });

  const browserView = (sessionId: string): SessionView => ({
    ...forBrowser(store.getSession(sessionId, baseUrl)),
    agentWatching: watching(sessionId),
  });
  const stateMessage = (sessionId: string) =>
    JSON.stringify({ type: "state", session: browserView(sessionId) });
  const broadcast = (sessionId: string) => {
    let body;
    try {
      body = stateMessage(sessionId);
    } catch {
      return;
    }
    sockets.send(sessionId, body);
  };
  const later = (fn: () => void) => setTimeout(fn, 0);
  // Pages refetch the interview list when told, so the switcher's
  // "waiting on you" dot stays current; a burst of events sends one ping.
  let overviewPing: ReturnType<typeof setTimeout> | null = null;
  const pingOverview = () => {
    overviewPing ??= setTimeout(() => {
      overviewPing = null;
      sockets.sendAll(JSON.stringify({ type: "overview" }));
    }, OVERVIEW_PING_MS);
  };
  // An interview that had nothing open and gains questions now waits on the
  // user: notify their devices once per burst of added questions.
  const added = new Map<string, number>();
  const notify = async () => {
    if (!options.push) return;
    const endpoints = store.pushSubscriptions();
    await Promise.all(
      endpoints.map(async (endpoint) => {
        const status = await options.push!.send(endpoint).catch(() => 0);
        // Gone: the device unsubscribed or the app was uninstalled.
        if (status === 404 || status === 410)
          store.removePushSubscription(endpoint);
      }),
    );
  };
  // The agent's chat replies notify too, once per burst.
  const replied = new Set<string>();
  const checkWaiting = (sessionId: string) => {
    const count = added.get(sessionId) ?? 0;
    added.delete(sessionId);
    const open = store.openQuestions(sessionId);
    if (open > 0 && open - count <= 0) void notify();
  };
  const features: Feature[] = allFeatures({
    sql: options.sql,
    store,
    env: options.env ?? {},
    notify: () => void notify(),
    changed: () => {
      pingOverview();
      scheduleInboxCheck();
    },
  });
  /** Oldest first; items that can wait (an idle agent) after the rest. */
  const inbox = () =>
    features
      .flatMap((feature) => {
        try {
          return feature.inbox?.() ?? [];
        } catch (error) {
          console.error(`inbox ${feature.name}`, error);
          return [];
        }
      })
      .sort(
        (a, b) =>
          Number(Boolean(a.later)) - Number(Boolean(b.later)) ||
          a.since.localeCompare(b.since),
      );

  // Any feature's new inbox item pushes to Tim's devices once. Requests are
  // left out: checkWaiting above already pushes when questions arrive.
  options.sql.exec(
    "CREATE TABLE IF NOT EXISTS kim_inbox_seen (id TEXT PRIMARY KEY, seen_at TEXT NOT NULL)",
  );
  const checkInbox = () => {
    const items = inbox();
    const seen = new Set(
      options.sql
        .all("SELECT id FROM kim_inbox_seen")
        .map((row) => String(row.id)),
    );
    // The first check ever only records what is already there.
    const seeding = !seen.has(SEEDED);
    const fresh = items.filter((item) => !seen.has(item.id));
    const time = new Date().toISOString();
    options.sql.transaction(() => {
      for (const id of seeding ? [SEEDED] : [])
        options.sql.all(
          "INSERT INTO kim_inbox_seen (id, seen_at) VALUES (?, ?)",
          id,
          time,
        );
      for (const item of fresh)
        options.sql.all(
          "INSERT INTO kim_inbox_seen (id, seen_at) VALUES (?, ?)",
          item.id,
          time,
        );
      // Forget items that went away, so one that comes back pushes again.
      const current = new Set([SEEDED, ...items.map((item) => item.id)]);
      for (const id of seen)
        if (!current.has(id))
          options.sql.all("DELETE FROM kim_inbox_seen WHERE id = ?", id);
    });
    if (!seeding && fresh.some((item) => item.kind !== "request"))
      void notify();
  };
  let inboxCheck: ReturnType<typeof setTimeout> | null = null;
  const scheduleInboxCheck = () => {
    inboxCheck ??= setTimeout(() => {
      inboxCheck = null;
      try {
        checkInbox();
      } catch (error) {
        console.error("inbox check", error);
      }
    }, PUSH_SETTLE_MS);
  };
  /** Runs each feature's timer work; the Durable Object alarm calls it. */
  const tick = async (now = Date.now()) => {
    for (const feature of features)
      try {
        await feature.tick?.(now);
      } catch (error) {
        console.error(`tick ${feature.name}`, error);
      }
    try {
      checkInbox();
    } catch (error) {
      console.error("inbox check", error);
    }
  };

  store.subscribe((event) => {
    if (event.type === "question.added") {
      if (!added.has(event.sessionId))
        setTimeout(() => checkWaiting(event.sessionId), PUSH_SETTLE_MS);
      added.set(event.sessionId, (added.get(event.sessionId) ?? 0) + 1);
    }
    if (event.type === "chat.reply" && !replied.has(event.sessionId)) {
      replied.add(event.sessionId);
      setTimeout(() => {
        replied.delete(event.sessionId);
        void notify();
      }, PUSH_SETTLE_MS);
    }
    later(() => {
      const watcher = watchers.get(event.sessionId);
      if (watcher?.write(event)) store.markDelivered(event.sessionId, event.id);
      broadcast(event.sessionId);
      if (OVERVIEW_EVENTS.test(event.type)) {
        pingOverview();
        scheduleInboxCheck();
      }
    });
  });

  const body = async (c: Context): Promise<Record<string, unknown>> =>
    ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const tokenSession = (token: string) => {
    const id = store.sessionIdForToken(token);
    if (!id) throw new Error("Session not found");
    return id;
  };

  app.get("/health", (c) => c.json({ ok: true }));

  // Browser routes ride on the Access cookie, so refuse writes another site
  // could forge with it. Agent routes use bearer tokens and need no check.
  app.use("/api/browser/*", async (c, next) => {
    if (c.req.method !== "GET" && !sameSite(c.req.raw))
      return c.json({ error: "Cross-site request refused" }, 403);
    await next();
  });

  // An agent key lives in a cloud environment others may read, so it can
  // report and work but not delete, reconfigure, or manage keys.
  app.use("/api/sessions/*", async (c, next) => {
    if (c.req.header(VIA_KEY_HEADER) && !keyMayCall(c.req.method, c.req.path))
      return c.json(
        { error: "Agent keys can't do this; use a signed-in CLI" },
        403,
      );
    await next();
  });

  // Keep it moving: feature routes, mounted before the :id and :token routes.
  const kimAgent = new Hono();
  const kimBrowser = new Hono();
  const internal = new Hono();
  kimAgent.get("/inbox", (c) => c.json({ items: inbox() }));
  kimBrowser.get("/inbox", (c) => c.json({ items: inbox() }));
  // Every project with the rail's numbers, merged from each feature.
  kimBrowser.get("/projects", (c) => {
    const stats = new Map<string, ProjectStats>();
    for (const feature of features)
      for (const [id, part] of Object.entries(feature.projectStats?.() ?? {}))
        stats.set(id, { ...stats.get(id), ...part });
    const needs = new Map<string, number>();
    for (const item of inbox())
      if (item.projectId)
        needs.set(item.projectId, (needs.get(item.projectId) ?? 0) + 1);
    return c.json({
      projects: store.listProjects().map((project) => ({
        ...project,
        stats: {
          ...stats.get(project.id),
          needsYou: needs.get(project.id) ?? 0,
        },
      })),
    });
  });
  for (const feature of features) {
    feature.agentRoutes?.(kimAgent);
    feature.browserRoutes?.(kimBrowser);
    feature.internalRoutes?.(internal);
  }
  app.route("/api/sessions/kim", kimAgent);
  app.route("/api/browser/kim", kimBrowser);
  app.route("/internal", internal);

  // Agent routes. Fixed paths go before /api/sessions/:id.
  app.get("/api/sessions/projects", (c) => c.json(store.listProjects()));
  app.post("/api/sessions/projects/update", async (c) => {
    const input = await body(c);
    const project = store.updateProject(String(input.project ?? ""), {
      name: input.name === undefined ? undefined : String(input.name),
      color: input.color === undefined ? undefined : String(input.color),
    });
    pingOverview();
    return c.json(project);
  });
  app.post("/api/sessions", async (c) =>
    c.json(forAgent(store.createSession(baseUrl, await body(c)))),
  );
  app.get("/api/sessions", (c) =>
    c.json(
      store.listSessions(baseUrl, c.req.query("all") === "true").map(forAgent),
    ),
  );
  app.get("/api/sessions/:id", (c) =>
    c.json(forAgent(store.getSession(c.req.param("id"), baseUrl))),
  );
  app.post("/api/sessions/:id/stop", (c) => {
    store.setSessionStatus(c.req.param("id"), "stopped");
    return c.json({ ok: true });
  });
  app.post("/api/sessions/:id/resume", (c) => {
    store.setSessionStatus(c.req.param("id"), "active");
    return c.json({ ok: true });
  });
  app.delete("/api/sessions/:id", (c) => {
    store.deleteSession(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/questions", async (c) => {
    const input = (await c.req.json()) as { questions?: unknown[] } | unknown[];
    const inputs = Array.isArray(input)
      ? input
      : Array.isArray(input?.questions)
        ? input.questions
        : [input];
    return c.json({
      questions: store.addQuestions(c.req.param("id"), inputs),
    });
  });
  app.patch("/api/sessions/:id/questions/:questionId", async (c) =>
    c.json(
      store.updateQuestion(
        c.req.param("id"),
        c.req.param("questionId"),
        await c.req.json(),
      ),
    ),
  );
  app.delete("/api/sessions/:id/questions/:questionId", (c) => {
    store.deleteQuestion(c.req.param("id"), c.req.param("questionId"));
    return c.json({ ok: true });
  });
  app.post("/api/sessions/:id/focus", async (c) => {
    store.focusQuestions(c.req.param("id"), focusIds(await body(c)));
    return c.json({ ok: true });
  });
  app.post("/api/sessions/:id/questions/:questionId/answer", async (c) =>
    c.json(
      store.answerQuestion(
        c.req.param("id"),
        c.req.param("questionId"),
        await c.req.json(),
      ),
    ),
  );
  app.post("/api/sessions/:id/artifacts", async (c) =>
    c.json(
      withoutContent(store.addArtifact(c.req.param("id"), await c.req.json())),
    ),
  );
  app.patch("/api/sessions/:id/artifacts/:artifactId", async (c) =>
    c.json(
      withoutContent(
        store.updateArtifact(
          c.req.param("id"),
          c.req.param("artifactId"),
          await c.req.json(),
        ),
      ),
    ),
  );
  app.delete("/api/sessions/:id/artifacts/:artifactId", (c) => {
    store.deleteArtifact(c.req.param("id"), c.req.param("artifactId"));
    return c.json({ ok: true });
  });
  app.post("/api/sessions/:id/stage", async (c) => {
    const input = await body(c);
    store.showArtifact(
      c.req.param("id"),
      (input.artifactId as string | null | undefined) ?? null,
      "agent",
    );
    return c.json({ ok: true });
  });
  app.post("/api/sessions/:id/stage/visibility", async (c) => {
    const input = await body(c);
    store.setStageVisible(c.req.param("id"), Boolean(input.visible), "agent");
    return c.json({ ok: true, stageVisible: Boolean(input.visible) });
  });
  app.get("/api/sessions/:id/chat", (c) =>
    c.json({ messages: store.getSession(c.req.param("id"), baseUrl).chat }),
  );
  app.post("/api/sessions/:id/chat", async (c) =>
    c.json(store.addChatMessage(c.req.param("id"), "agent", await body(c))),
  );
  app.get("/api/sessions/:id/attach", (c) => {
    const id = c.req.param("id");
    store.getSession(id, baseUrl);
    const encoder = new TextEncoder();
    let lease: Watcher | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (heartbeat) clearInterval(heartbeat);
      release(id, lease);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const writeLine = (value: unknown) => {
          if (!open) return false;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
            return true;
          } catch {
            open = false;
            stop();
            return false;
          }
        };
        const pending = store.undeliveredEvents(id);
        writeLine({
          type: "snapshot",
          session: forAgent(store.getSession(id, baseUrl)),
          events: pending,
        });
        if (pending.length) store.markDelivered(id, pending.at(-1)!.id);
        lease = {
          write: (event) => writeLine({ type: "event", event }),
          replace: () => {
            writeLine({ type: "replaced", message: REPLACED });
            open = false;
            stop();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          },
        };
        claim(id, lease);
        // Proxies drop idle connections; a heartbeat line keeps this one open.
        heartbeat = setInterval(
          () => writeLine({ type: "heartbeat" }),
          HEARTBEAT_MS,
        );
        c.req.raw.signal.addEventListener("abort", () => {
          open = false;
          stop();
        });
        later(() => broadcast(id));
      },
      cancel: stop,
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      },
    });
  });

  app.get("/api/sessions/:id/events/next", async (c) => {
    const id = c.req.param("id");
    store.getSession(id, baseUrl);
    const existing = store.undeliveredEvents(id);
    if (existing.length) {
      store.markDelivered(id, existing.at(-1)!.id);
      later(() => broadcast(id));
      return c.json({
        session: forAgent(store.getSession(id, baseUrl)),
        events: existing,
      });
    }
    const timeout = bounded(c.req.query("timeout"), 25_000, 0, 30_000);
    const events = await new Promise<InterviewEvent[] | null>((resolve) => {
      const finish = (found: InterviewEvent[] | null) => {
        clearTimeout(timer);
        release(id, watcher);
        resolve(found);
      };
      const watcher: Watcher = {
        write: (event) => {
          finish([event]);
          return false;
        },
        replace: () => finish(null),
      };
      claim(id, watcher);
      const timer = setTimeout(() => finish([]), timeout);
      c.req.raw.signal.addEventListener("abort", () => finish([]));
    });
    if (!events) throw new Error(REPLACED);
    if (events.length) store.markDelivered(id, events.at(-1)!.id);
    later(() => broadcast(id));
    return c.json({ session: forAgent(store.getSession(id, baseUrl)), events });
  });

  app.get("/api/sessions/:id/wait", async (c) => {
    const id = c.req.param("id");
    store.getSession(id, baseUrl);
    const batch = await waitForBatch(id, {
      idle: bounded(c.req.query("idle"), 15_000, 0, 600_000),
      timeout: bounded(c.req.query("timeout"), 600_000, 0, 3_600_000),
      partial: c.req.query("partial") === "1",
      signal: c.req.raw.signal,
      store,
      claim: (watcher) => claim(id, watcher),
      release: (watcher) => release(id, watcher),
      broadcast,
    });
    if (!batch) throw new Error(REPLACED);
    return c.json(batch);
  });

  // Browser routes. Cloudflare Access already limits them to the owner, so
  // the interview list needs no session token.
  app.get("/api/browser/overview", (c) =>
    c.json({ sessions: store.summaries() }),
  );
  app.get("/api/browser/push/key", (c) =>
    c.json({ publicKey: options.push?.publicKey ?? null }),
  );
  app.post("/api/browser/push/subscribe", async (c) => {
    store.addPushSubscription(String((await body(c)).endpoint ?? ""));
    return c.json({ ok: true });
  });
  app.post("/api/browser/push/unsubscribe", async (c) => {
    store.removePushSubscription(String((await body(c)).endpoint ?? ""));
    return c.json({ ok: true });
  });
  app.post("/api/browser/push/test", async (c) => {
    if (!options.push) return c.json({ error: "Push is not configured" }, 503);
    await notify();
    return c.json({ ok: true, devices: store.pushSubscriptions().length });
  });
  // The rest are addressed by the session's secret token.
  app.get("/api/browser/:token/session", (c) =>
    c.json(browserView(tokenSession(c.req.param("token")))),
  );
  app.get("/api/browser/:token/artifacts/:artifactId/view", (c) => {
    const { format, content } = store.artifactContent(
      tokenSession(c.req.param("token")),
      c.req.param("artifactId"),
    );
    if (format !== "html") throw new Error("Only html artifacts have a view");
    return new Response(content, { headers: ARTIFACT_VIEW_HEADERS });
  });
  app.post("/api/browser/:token/questions/:questionId/answer", async (c) =>
    c.json(
      store.answerQuestion(
        tokenSession(c.req.param("token")),
        c.req.param("questionId"),
        await c.req.json(),
      ),
    ),
  );
  app.post("/api/browser/:token/chat", async (c) =>
    c.json(
      store.addChatMessage(
        tokenSession(c.req.param("token")),
        "user",
        await body(c),
      ),
    ),
  );
  app.post("/api/browser/:token/stage", async (c) => {
    const input = await body(c);
    store.showArtifact(
      tokenSession(c.req.param("token")),
      (input.artifactId as string | null | undefined) ?? null,
      "user",
    );
    return c.json({ ok: true });
  });
  app.post("/api/browser/:token/stage/visibility", async (c) => {
    const input = await body(c);
    store.setStageVisible(
      tokenSession(c.req.param("token")),
      Boolean(input.visible),
      "user",
    );
    return c.json({ ok: true });
  });
  return { app, broadcast, stateMessage, tokenSession, tick, inbox };
}

const HEARTBEAT_MS = 25_000;
const OVERVIEW_PING_MS = 300;
/** Agents add a batch of questions in a burst; notify once it has landed. */
const PUSH_SETTLE_MS = 1_500;
/** How long an agent between chained `wait` requests still counts as watching. */
const WATCH_GRACE_MS = 5_000;
/** Marks kim_inbox_seen as seeded; never an inbox item id. */
const SEEDED = "*seeded*";
/** Events that change an interview's place in the switcher. */
const OVERVIEW_EVENTS = /^(session|question\.(added|deleted)|answer)\./;

/**
 * Whether a request came from this site's own pages. Browsers send
 * Sec-Fetch-Site, or at least Origin, on cross-site writes; a request with
 * neither (the CLI, a test) is not from a browser page.
 */
export function sameSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function withoutContent(artifact: ArtifactView): ArtifactView {
  const copy = { ...artifact };
  delete copy.content;
  delete copy.source;
  return copy;
}

/** Agents wrote the artifacts, so their copies of a session omit the content. */
export function forAgent(session: SessionView): SessionView {
  return {
    ...session,
    artifacts: session.artifacts.map(withoutContent),
  };
}

/**
 * The page loads html artifacts by URL, so state updates don't carry them;
 * an archify diagram alone is around 700 KB.
 */
export function forBrowser(session: SessionView): SessionView {
  return {
    ...session,
    artifacts: session.artifacts.map((artifact) => {
      if (artifact.format !== "html") return artifact;
      const copy = { ...artifact };
      delete copy.content;
      return copy;
    }),
  };
}

function focusIds(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.questionIds)) return body.questionIds.map(String);
  return body.questionId ? [String(body.questionId)] : [];
}

function bounded(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(value)
    ? Math.min(Math.max(value, min), max)
    : fallback;
}

/** Events the user caused; the agent's own edits never wake a batch wait. */
const USER_EVENTS = new Set([
  "answer.submitted",
  "answer.revised",
  "chat.message",
]);
/** Gathers a trailing burst, such as "Accept all defaults", into one batch. */
const SETTLE_MS = 750;

/**
 * Collects events until the user pauses for `idle` ms or finishes every open
 * question, then returns them as one batch.
 * A `partial` request that times out first returns `{ partial: true }` and
 * leaves the events queued, so a client can chain short requests into one
 * long wait. A wait a newer watcher took over resolves to null and leaves
 * the events queued for that watcher.
 */
async function waitForBatch(
  id: string,
  options: {
    idle: number;
    timeout: number;
    partial: boolean;
    signal: AbortSignal;
    store: InterviewStore;
    claim: (watcher: Watcher) => void;
    release: (watcher: Watcher) => void;
    broadcast: (id: string) => void;
  },
): Promise<unknown> {
  const { store, broadcast } = options;
  const events = store.undeliveredEvents(id);
  return new Promise((resolve) => {
    let done = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (complete: boolean | "replaced") => {
      if (done) return;
      done = true;
      clearTimeout(overall);
      if (quietTimer) clearTimeout(quietTimer);
      options.release(watcher);
      if (complete === "replaced") return resolve(null);
      if (!complete) return resolve({ partial: true });
      if (events.length) store.markDelivered(id, events.at(-1)!.id);
      setTimeout(() => broadcast(id), 0);
      resolve(batchSummary(store.getSession(id, ""), events));
    };
    const evaluate = () => {
      const userEvents = events.filter((event) => USER_EVENTS.has(event.type));
      if (!userEvents.length) return;
      const open = store
        .getSession(id, "")
        .questions.filter((question) => !question.answer).length;
      const latest = userEvents.at(-1)!;
      const since = Date.now() - Date.parse(latest.createdAt);
      // Someone who asked something is waiting on the reply.
      const quiet =
        open && latest.type !== "chat.message" ? options.idle : SETTLE_MS;
      const wait = Math.max(0, quiet - since);
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), wait);
    };
    const watcher: Watcher = {
      write: (event) => {
        if (!events.some((known) => known.id === event.id)) events.push(event);
        evaluate();
        return false;
      },
      replace: () => finish("replaced"),
    };
    options.claim(watcher);
    const overall = setTimeout(() => finish(!options.partial), options.timeout);
    options.signal.addEventListener("abort", () => finish(false));
    evaluate();
  });
}

/**
 * The batch an agent needs: what happened, the latest answer to each touched
 * question, and the user's new chat messages with the question each is about.
 */
function batchSummary(session: SessionView, events: InterviewEvent[]) {
  const touched = new Set(
    events
      .filter((event) => event.type.startsWith("answer."))
      .map((event) => String(event.payload.questionId)),
  );
  const asked = new Set(
    events
      .filter((event) => event.type === "chat.message")
      .map((event) => String(event.payload.messageId)),
  );
  const numbered = new Map(
    session.questions.map((question, index) => [
      question.id,
      { question, number: index + 1 },
    ]),
  );
  return {
    events,
    messages: session.chat
      .filter((message) => asked.has(message.id))
      .map((message) => {
        const about = message.questionId
          ? numbered.get(message.questionId)
          : undefined;
        return {
          messageId: message.id,
          text: message.text,
          about: about
            ? {
                questionId: about.question.id,
                number: about.number,
                prompt: about.question.prompt,
              }
            : null,
        };
      }),
    answers: session.questions
      .map((question, index) => ({ question, number: index + 1 }))
      .filter(({ question }) => touched.has(question.id) && question.answer)
      .map(({ question, number }) => ({
        questionId: question.id,
        number,
        prompt: question.prompt,
        answer: question.answer!.skipped ? null : question.answer!.text,
        skipped: question.answer!.skipped,
        acceptedDefault:
          !question.answer!.skipped &&
          question.answer!.text === defaultAnswerText(question),
      })),
    openQuestions: session.questions.filter((question) => !question.answer)
      .length,
    stageVisible: session.stageVisible,
    status: session.status,
  };
}

/** One path segment: an interview, question or artifact id. */
const ID = "[^/]+";

/**
 * The routes an agent key may call; anything else, including routes added
 * later, is refused. A key reports, raises and edits requests, waits on
 * them, replies in their chat, beats, syncs and reads the backlog, and reads
 * a project's context and writes its summary. Answering, deleting
 * interviews, reconfiguring projects and backlogs, and keys stay with a
 * signed-in CLI.
 */
const KEY_ALLOWED: Array<[method: string, path: RegExp]> = [
  ["GET", /^\/api\/sessions(\/projects)?$/],
  [
    "GET",
    new RegExp(`^/api/sessions/${ID}(/(attach|wait|events/next|chat))?$`),
  ],
  ["POST", /^\/api\/sessions$/],
  [
    "POST",
    new RegExp(
      `^/api/sessions/${ID}/(stop|resume|questions|focus|artifacts|stage|stage/visibility|chat)$`,
    ),
  ],
  ["PATCH", new RegExp(`^/api/sessions/${ID}/(questions|artifacts)/${ID}$`)],
  ["DELETE", new RegExp(`^/api/sessions/${ID}/(questions|artifacts)/${ID}$`)],
  [
    "GET",
    new RegExp(
      `^/api/sessions/kim/(inbox|automations|machines|prs|backlog|projects/context|sessions/${ID})$`,
    ),
  ],
  [
    "POST",
    /^\/api\/sessions\/kim\/(report|machines\/beat|heartbeat|followups|projects\/summary|backlog\/(sync|items|error))$/,
  ],
];

/** Whether a request authenticated by an agent key may go through. */
export function keyMayCall(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  // The kim routes are fixed paths: never let them fall through to /:id.
  if (/^\/api\/sessions\/kim(\/|$)/.test(path))
    return KEY_ALLOWED.some(
      ([allowed, pattern]) =>
        allowed === upper &&
        pattern.source.includes("kim") &&
        pattern.test(path),
    );
  return KEY_ALLOWED.some(
    ([allowed, pattern]) => allowed === upper && pattern.test(path),
  );
}
