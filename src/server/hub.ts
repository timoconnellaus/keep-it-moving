import { Hono, type Context } from "hono";
import { defaultAnswerText } from "../shared/answers.js";
import type {
  ArtifactView,
  InterviewEvent,
  SessionView,
} from "../shared/schema.js";
import { ARTIFACT_VIEW_HEADERS } from "./artifactView.js";
import { agentKeys, VIA_KEY_HEADER } from "./keys.js";
import type { Sql } from "./sql.js";
import { LIMIT_REACHED, type InterviewStore } from "./store.js";

/**
 * The header the Worker sets, to the signed-in email, on a request from an
 * interview's assignee rather than the workspace's owner. Like the agent key
 * header, it is stripped from what clients send.
 */
export const RESPONDENT_HEADER = "x-kim-respondent";
/** Who is assigning an interview, by name, as the assignee will see it. */
export const ASSIGNED_BY_HEADER = "x-kim-assigned-by";

/** Where browser state updates go: hibernating WebSockets in production. */
export interface BrowserSockets {
  send(sessionId: string, data: string): void;
  /** The assignee's pages, which see less of the workspace than the owner's. */
  sendRespondent?(sessionId: string, data: string): void;
  /** Unassigning shuts the old assignee's pages out at once. */
  closeRespondents?(sessionId: string): void;
  /** Every open page, whichever interview it shows. */
  sendAll(data: string): void;
  /** A deleted interview ends its pages' sockets, the assignee's too. */
  closeSession?(sessionId: string): void;
}

/**
 * What an agent's socket is waiting for. It is kept with the socket, not in
 * memory, so a hibernated Durable Object picks up where it left off.
 */
export interface AgentWatch {
  sessionId: string;
  /** wait: one batch; attach: every event; next: the next event. */
  mode: "wait" | "attach" | "next";
  /** wait: how long the user pauses before the batch goes. */
  idle: number;
  /** When a wait or next gives up, in ms since the epoch. */
  deadline: number;
}

export interface AgentSocket {
  readonly watch: AgentWatch;
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** Agents' WebSockets: hibernating in production, woken by an alarm. */
export interface AgentSockets {
  /** Accepts the upgrade; the response completes it. */
  accept(watch: AgentWatch): { socket: AgentSocket; response: Response };
  /** Open sockets, for one interview or every one. */
  list(sessionId?: string): AgentSocket[];
  /** Calls `wake` at this time, or never; the hub has one alarm. */
  wakeAt(time: number | null): void;
}

/** Close codes an agent socket ends with, beyond 1000 for done. */
export const AGENT_CLOSE = {
  replaced: 4409,
  deleted: 4404,
} as const;

/** Sends a data-less Web Push; resolves to the push service's HTTP status. */
export type PushSender = (endpoint: string) => Promise<number>;

export interface HubOptions {
  store: InterviewStore;
  /** The store's database, for the agent keys table. */
  sql: Sql;
  /** The public origin, used in session URLs. */
  baseUrl: string;
  sockets: BrowserSockets;
  /** Agents waiting over WebSockets; without it only the HTTP waits work. */
  agentSockets?: AgentSockets | undefined;
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
  const { store, baseUrl, sockets, agentSockets } = options;
  // Older CLIs' long-polls, held in memory for as long as the request runs.
  const watchers = new Map<string, Watcher>();
  // `kim wait` runs once per batch, so an agent counts as watching for a
  // moment after its wait ends; the chat says whether anyone will read.
  const watchedUntil = new Map<string, number>();
  const watching = (id: string) =>
    watchers.has(id) ||
    Boolean(agentSockets?.list(id).length) ||
    (watchedUntil.get(id) ?? 0) > Date.now();
  /** A newer watcher takes over: whatever held the interview ends. */
  const replaceWatchers = (id: string) => {
    watchers.get(id)?.replace();
    for (const socket of agentSockets?.list(id) ?? [])
      endSocket(
        socket,
        { type: "replaced", message: REPLACED },
        AGENT_CLOSE.replaced,
      );
  };
  const claim = (id: string, watcher: Watcher) => {
    const was = watching(id);
    replaceWatchers(id);
    watchers.set(id, watcher);
    if (!was) later(() => broadcast(id));
  };
  /** Watching ends after a grace period, unless another watcher starts. */
  const unwatched = (id: string) => {
    watchedUntil.set(id, Date.now() + WATCH_GRACE_MS);
    setTimeout(() => {
      if (!watching(id)) broadcast(id);
    }, WATCH_GRACE_MS + 50);
  };
  const release = (id: string, watcher: Watcher | null) => {
    if (!watcher || watchers.get(id) !== watcher) return;
    watchers.delete(id);
    unwatched(id);
  };

  const endSocket = (socket: AgentSocket, last: unknown, code = 1000) => {
    try {
      socket.send(JSON.stringify(last));
      socket.close(code, code === 1000 ? "Done" : String(code));
    } catch {
      /* already closing */
    }
  };
  /** Sends a waiting socket its batch, marking it delivered, and ends it. */
  const sendBatch = (socket: AgentSocket) => {
    const id = socket.watch.sessionId;
    const events = store.undeliveredEvents(id);
    if (events.length) store.markDelivered(id, events.at(-1)!.id);
    endSocket(socket, {
      type: "batch",
      batch: batchSummary(store.getSession(id, ""), events),
    });
    later(() => broadcast(id));
  };
  const sendNext = (socket: AgentSocket, events: InterviewEvent[]) => {
    const id = socket.watch.sessionId;
    if (events.length) store.markDelivered(id, events.at(-1)!.id);
    endSocket(socket, {
      type: "next",
      result: { session: forAgent(store.getSession(id, baseUrl)), events },
    });
    later(() => broadcast(id));
  };
  /**
   * Settles a socket against the store and the clock: a due batch or
   * timeout goes now. Returns when it next needs a look, or null.
   */
  const review = (socket: AgentSocket, now: number): number | null => {
    const { sessionId: id, mode, idle, deadline } = socket.watch;
    if (mode === "attach") return null;
    if (mode === "next") {
      if (now < deadline) return deadline;
      sendNext(socket, []);
      return null;
    }
    const events = store.undeliveredEvents(id);
    const due = batchDue(events, unanswered(store, id), idle);
    if ((due !== null && due <= now) || deadline <= now) {
      sendBatch(socket);
      return null;
    }
    return due === null ? deadline : Math.min(due, deadline);
  };
  /** Looks at every agent socket and sets the alarm for the next look. */
  const wake = () => {
    if (!agentSockets) return;
    const now = Date.now();
    let next: number | null = null;
    for (const socket of agentSockets.list()) {
      const at = review(socket, now);
      if (at !== null && (next === null || at < next)) next = at;
    }
    agentSockets.wakeAt(next);
  };
  const deliverToSockets = (event: InterviewEvent) => {
    if (!agentSockets) return;
    const open = agentSockets.list(event.sessionId);
    if (!open.length) return;
    // A socket opened since the event began has it already.
    const pending = store
      .undeliveredEvents(event.sessionId)
      .some((known) => known.id === event.id);
    if (pending)
      for (const socket of open)
        if (socket.watch.mode === "attach") {
          socket.send(JSON.stringify({ type: "event", event }));
          store.markDelivered(event.sessionId, event.id);
        } else if (socket.watch.mode === "next") sendNext(socket, [event]);
    // A wait's batch may be due sooner now.
    wake();
  };
  /** An agent's socket, already checked by the Worker and the key rules. */
  const openAgentSocket = (watch: AgentWatch): Response => {
    const id = watch.sessionId;
    replaceWatchers(id);
    const { socket, response } = agentSockets!.accept(watch);
    if (watch.mode === "attach") {
      const pending = store.undeliveredEvents(id);
      socket.send(
        JSON.stringify({
          type: "snapshot",
          session: forAgent(store.getSession(id, baseUrl)),
          events: pending,
        }),
      );
      if (pending.length) store.markDelivered(id, pending.at(-1)!.id);
    }
    if (watch.mode === "next") {
      const pending = store.undeliveredEvents(id);
      if (pending.length) sendNext(socket, pending);
    }
    wake();
    later(() => broadcast(id));
    return response;
  };
  /** The host saw an agent socket close. */
  const agentSocketClosed = (sessionId: string) => {
    unwatched(sessionId);
    wake();
  };
  const app = new Hono();

  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message)
      ? 404
      : /can't manage keys/i.test(message) || message.startsWith(LIMIT_REACHED)
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
  const stateMessage = (sessionId: string, respondent = false) =>
    JSON.stringify({
      type: "state",
      session: respondent
        ? forRespondent(browserView(sessionId))
        : browserView(sessionId),
    });
  const broadcast = (sessionId: string) => {
    let body;
    try {
      body = stateMessage(sessionId);
    } catch {
      return;
    }
    sockets.send(sessionId, body);
    if (sockets.sendRespondent && store.getSession(sessionId, "").assignee)
      sockets.sendRespondent(sessionId, stateMessage(sessionId, true));
  };
  /** Whether this email may use the interview with this token as its assignee. */
  const respondentMayUse = (token: string, email: string) =>
    Boolean(email) && store.assigneeForToken(token) === email.toLowerCase();
  const later = (fn: () => void) => setTimeout(fn, 0);
  // Pages refetch the interview list when told, so the home page and the
  // switcher's "waiting on you" dot stay current; a burst sends one ping.
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
  const answeredBy = new Set<string>();
  const checkWaiting = (sessionId: string) => {
    const count = added.get(sessionId) ?? 0;
    added.delete(sessionId);
    const open = store.openQuestions(sessionId);
    if (open > 0 && open - count <= 0) void notify();
  };
  store.subscribe((event) => {
    if (event.type === "question.added") {
      if (!added.has(event.sessionId))
        setTimeout(() => checkWaiting(event.sessionId), PUSH_SETTLE_MS);
      added.set(event.sessionId, (added.get(event.sessionId) ?? 0) + 1);
    }
    // An assignee's answers come back to the owner: one push per burst.
    if (
      event.type.startsWith("answer.") &&
      event.payload.by &&
      !answeredBy.has(event.sessionId)
    ) {
      answeredBy.add(event.sessionId);
      setTimeout(() => {
        answeredBy.delete(event.sessionId);
        void notify();
      }, PUSH_SETTLE_MS);
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
      deliverToSockets(event);
      broadcast(event.sessionId);
      if (OVERVIEW_EVENTS.test(event.type)) pingOverview();
    });
  });

  const body = async (c: Context): Promise<Record<string, unknown>> =>
    ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const tokenSession = (token: string) => {
    const id = store.sessionIdForToken(token);
    if (!id) throw new Error("Session not found");
    return id;
  };
  /** Assigns or clears; the Worker updates its share directory from the reply. */
  const assign = (c: Context, id: string, input: Record<string, unknown>) => {
    const by = c.req.header(ASSIGNED_BY_HEADER);
    const { assignee, previous } = store.assignSession(
      id,
      input.email ? String(input.email) : null,
      by ? decodeURIComponent(by) : null,
    );
    if (previous && previous !== assignee) sockets.closeRespondents?.(id);
    const session = store.getSession(id, baseUrl);
    return {
      id,
      token: session.token,
      title: session.title,
      url: session.url,
      assignee,
      previous,
      assignedBy: session.assignedBy,
    };
  };
  /** The assignee's email when an assignee made this request. */
  const respondentOf = (c: Context) => c.req.header(RESPONDENT_HEADER) ?? null;

  app.get("/health", (c) => c.json({ ok: true }));

  // An assignee reaches one interview, by its token, and nothing else in
  // the workspace: not the list, keys or devices.
  app.use("*", async (c, next) => {
    const respondent = c.req.header(RESPONDENT_HEADER);
    if (respondent === undefined) return next();
    const token = respondentToken(c.req.method, c.req.path);
    if (!token || !respondentMayUse(token, respondent))
      return c.json({ error: "Not shared with you" }, 403);
    await next();
  });

  // Browser routes ride on the session cookie, so refuse writes another site
  // could forge with it. Agent routes use bearer tokens and need no check.
  app.use("/api/browser/*", async (c, next) => {
    if (c.req.method !== "GET" && !sameSite(c.req.raw))
      return c.json({ error: "Cross-site request refused" }, 403);
    await next();
  });

  // An agent key lives in a cloud environment others may read, so it can
  // work on interviews but not answer, delete, or manage keys.
  app.use("/api/sessions/*", async (c, next) => {
    if (c.req.header(VIA_KEY_HEADER) && !keyMayCall(c.req.method, c.req.path))
      return c.json(
        { error: "Agent keys can't do this; use a signed-in CLI" },
        403,
      );
    await next();
  });

  // Agent keys, mounted before the :id routes.
  const keys = agentKeys(options.sql);
  app.route("/api/sessions/kim", keys.agentRoutes);
  app.route("/internal", keys.internalRoutes);

  // Agent routes. Fixed paths go before /api/sessions/:id.
  app.get("/api/sessions/projects", (c) => c.json(store.listProjects()));
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
    const { id, title, token, assignee } = store.getSession(
      c.req.param("id"),
      baseUrl,
    );
    store.deleteSession(id);
    sockets.closeSession?.(id);
    for (const socket of agentSockets?.list(id) ?? [])
      endSocket(
        socket,
        { type: "deleted", message: "Session not found" },
        AGENT_CLOSE.deleted,
      );
    // The Worker forgets the share when there was one.
    return c.json({ ok: true, id, title, token, assignee });
  });
  app.post("/api/sessions/:id/assign", async (c) =>
    c.json(assign(c, c.req.param("id"), await body(c))),
  );

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

  // The CLI waits over a WebSocket, which the Durable Object can hibernate
  // while nothing happens; the HTTP waits below stay for older CLIs.
  app.get("/api/sessions/:id/socket", (c) => {
    if (!agentSockets)
      return c.json({ error: "Sockets are not available here" }, 501);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      return c.json({ error: "Expected a WebSocket" }, 426);
    const id = c.req.param("id");
    store.getSession(id, baseUrl);
    const mode = c.req.query("mode") ?? "wait";
    if (mode !== "wait" && mode !== "attach" && mode !== "next")
      return c.json({ error: `Unknown mode ${mode}` }, 400);
    const timeout =
      mode === "next"
        ? bounded(c.req.query("timeout"), 25_000, 0, 30_000)
        : bounded(c.req.query("timeout"), 600_000, 0, SOCKET_WAIT_MAX_MS);
    return openAgentSocket({
      sessionId: id,
      mode,
      idle: bounded(c.req.query("idle"), 15_000, 0, 600_000),
      deadline: Date.now() + timeout,
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

  // Browser routes. The Worker sends only this workspace's signed-in user
  // here, so the interview list needs no session token.
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
  app.get("/api/browser/:token/session", (c) => {
    const view = browserView(tokenSession(c.req.param("token")));
    return c.json(respondentOf(c) ? forRespondent(view) : view);
  });
  app.post("/api/browser/:token/assign", async (c) =>
    c.json(assign(c, tokenSession(c.req.param("token")), await body(c))),
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
        respondentOf(c),
      ),
    ),
  );
  app.post("/api/browser/:token/chat", async (c) =>
    c.json(
      store.addChatMessage(
        tokenSession(c.req.param("token")),
        "user",
        await body(c),
        respondentOf(c),
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
  return {
    app,
    broadcast,
    stateMessage,
    tokenSession,
    respondentMayUse,
    /** The alarm went off: settle agent sockets whose time has come. */
    wake,
    agentSocketClosed,
  };
}

const HEARTBEAT_MS = 25_000;
/** A socket costs nothing while it waits, so it may wait a week. */
const SOCKET_WAIT_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const OVERVIEW_PING_MS = 300;
/** Agents add a batch of questions in a burst; notify once it has landed. */
const PUSH_SETTLE_MS = 1_500;
/** How long an agent between chained `wait` requests still counts as watching. */
const WATCH_GRACE_MS = 5_000;
/** Events that change an interview's row in the list or the switcher. */
const OVERVIEW_EVENTS = /^(session|question\.(added|deleted)|answer|chat)\./;

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
 * What an assignee sees: the interview, but not where it runs in the
 * owner's workspace.
 */
export function forRespondent(session: SessionView): SessionView {
  return {
    ...session,
    project: null,
    origin: {
      branch: null,
      worktree: null,
      agent: null,
      agentSession: null,
      location: null,
    },
    respondent: true,
  };
}

/** The routes an assignee's interview page uses, each scoped to its token. */
const RESPONDENT_ALLOWED: Array<[method: string, path: RegExp]> = [
  ["GET", /^\/api\/browser\/([^/]+)\/(session|artifacts\/[^/]+\/view)$/],
  [
    "POST",
    /^\/api\/browser\/([^/]+)\/(questions\/[^/]+\/answer|chat|stage|stage\/visibility)$/,
  ],
];

/** The token a respondent's request is for, or null when it may not make it. */
function respondentToken(method: string, path: string): string | null {
  for (const [allowed, pattern] of RESPONDENT_ALLOWED) {
    const match = method.toUpperCase() === allowed && pattern.exec(path);
    if (match) return match[1]!;
  }
  return null;
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
/** Questions still without an answer, whoever they wait on. */
const unanswered = (store: InterviewStore, id: string) =>
  store.getSession(id, "").questions.filter((question) => !question.answer)
    .length;

/** Gathers a trailing burst, such as "Accept all defaults", into one batch. */
const SETTLE_MS = 750;

/**
 * When a batch of these events is due: once the user has paused for `idle`
 * ms, or settled briefly when nothing is left open or they asked something
 * in the chat. Null while nothing the user did is waiting.
 */
function batchDue(
  events: InterviewEvent[],
  open: number,
  idle: number,
): number | null {
  const latest = events.filter((event) => USER_EVENTS.has(event.type)).at(-1);
  if (!latest) return null;
  // Someone who asked something is waiting on the reply.
  const quiet = open && latest.type !== "chat.message" ? idle : SETTLE_MS;
  return Date.parse(latest.createdAt) + quiet;
}

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
      const due = batchDue(events, unanswered(store, id), options.idle);
      if (due === null) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(
        () => finish(true),
        Math.max(0, due - Date.now()),
      );
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
          ...(message.authorEmail ? { from: message.authorEmail } : {}),
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
        ...(question.answer!.answeredBy
          ? { answeredBy: question.answer!.answeredBy }
          : {}),
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
 * later, is refused. A key creates and edits interviews, waits on them,
 * replies in their chat and assigns them to someone. Answering, deleting
 * interviews and managing keys stay with a signed-in CLI.
 */
const KEY_ALLOWED: Array<[method: string, path: RegExp]> = [
  ["GET", /^\/api\/sessions(\/projects)?$/],
  [
    "GET",
    new RegExp(
      `^/api/sessions/${ID}(/(attach|wait|events/next|socket|chat))?$`,
    ),
  ],
  ["POST", /^\/api\/sessions$/],
  [
    "POST",
    new RegExp(
      `^/api/sessions/${ID}/(stop|resume|questions|focus|artifacts|stage|stage/visibility|chat|assign)$`,
    ),
  ],
  ["PATCH", new RegExp(`^/api/sessions/${ID}/(questions|artifacts)/${ID}$`)],
  ["DELETE", new RegExp(`^/api/sessions/${ID}/(questions|artifacts)/${ID}$`)],
];

/** Whether a request authenticated by an agent key may go through. */
export function keyMayCall(method: string, path: string): boolean {
  // The kim routes are fixed paths a key may not use: never let them fall
  // through to /:id.
  if (/^\/api\/sessions\/kim(\/|$)/.test(path)) return false;
  const upper = method.toUpperCase();
  return KEY_ALLOWED.some(
    ([allowed, pattern]) => allowed === upper && pattern.test(path),
  );
}
