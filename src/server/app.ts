import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import staticPlugin from "@fastify/static";
import {
  Behavior,
  GoogleGenAI,
  Modality,
  Type,
  type FunctionDeclaration,
} from "@google/genai";
import { ARTIFACT_VIEW_HEADERS, capturableDocument } from "./artifactView.js";
import { geminiApiKey } from "./config.js";
import { InterviewStore } from "./store.js";
import { defaultAnswerText } from "../shared/answers.js";
import {
  ARTIFACT_MAX_BYTES,
  type ArtifactView,
  type InterviewEvent,
  type SessionView,
} from "../shared/schema.js";

interface AppOptions {
  store: InterviewStore;
  host?: string;
  port?: number;
  webRoot?: string;
  /** Where to look for a stored Gemini key; tests point this somewhere empty. */
  geminiKeyFile?: string;
}
interface Watcher {
  write: (event: InterviewEvent) => boolean;
  close: () => void;
}

const packageVersion = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const startedAt = new Date().toISOString();
  const app = Fastify({ logger: false });
  const store = options.store;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 47831;
  const baseUrl = `http://${host}:${port}`;
  const watchers = new Map<string, Watcher>();
  const sockets = new Map<
    string,
    Set<{ send(data: string): void; readyState: number }>
  >();

  await app.register(websocket);
  const webRoot = options.webRoot ?? join(process.cwd(), "web-dist");
  if (existsSync(webRoot)) await app.register(staticPlugin, { root: webRoot });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origin !== baseUrl && origin !== "http://127.0.0.1:5173") {
      await reply.code(403).send({ error: "Origin not allowed" });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message)
      ? 404
      : /stopped|already attached|origin/i.test(message)
        ? 409
        : 400;
    void reply.code(status).send({ error: message });
  });

  const broadcast = (sessionId: string) => {
    let state;
    try {
      state = store.getSession(sessionId, baseUrl);
    } catch {
      return;
    }
    const body = JSON.stringify({ type: "state", session: forBrowser(state) });
    for (const socket of sockets.get(sessionId) ?? [])
      if (socket.readyState === 1) socket.send(body);
  };
  const unsubscribe = store.subscribe((event) => {
    setImmediate(() => {
      const watcher = watchers.get(event.sessionId);
      if (watcher?.write(event)) {
        store.markDelivered(event.sessionId, event.id);
      }
      broadcast(event.sessionId);
    });
  });
  app.addHook("onClose", async () => unsubscribe());

  app.get("/health", async () => ({ ok: true }));
  app.get("/api/daemon", async () => ({
    pid: process.pid,
    version: packageVersion,
    startedAt,
    geminiKey: geminiApiKey(options.geminiKeyFile) !== null,
  }));
  app.post("/api/sessions", async (request) =>
    store.createSession(baseUrl, request.body ?? {}),
  );
  app.get("/api/sessions", async (request) =>
    store
      .listSessions(baseUrl, (request.query as { all?: string }).all === "true")
      .map(forAgent),
  );
  app.get("/api/sessions/:id", async (request) =>
    forAgent(store.getSession((request.params as { id: string }).id, baseUrl)),
  );
  app.post("/api/sessions/:id/stop", async (request) => {
    store.setSessionStatus((request.params as { id: string }).id, "stopped");
    return { ok: true };
  });
  app.post("/api/sessions/:id/resume", async (request) => {
    store.setSessionStatus((request.params as { id: string }).id, "active");
    return { ok: true };
  });
  app.delete("/api/sessions/:id", async (request) => {
    store.deleteSession((request.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/api/sessions/:id/questions", async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { questions?: unknown[] } | unknown[];
    const inputs = Array.isArray(body)
      ? body
      : Array.isArray(body?.questions)
        ? body.questions
        : [body];
    return { questions: store.addQuestions(id, inputs) };
  });
  app.patch("/api/sessions/:id/questions/:questionId", async (request) =>
    store.updateQuestion(
      (request.params as { id: string }).id,
      (request.params as { questionId: string }).questionId,
      request.body,
    ),
  );
  app.delete("/api/sessions/:id/questions/:questionId", async (request) => {
    store.deleteQuestion(
      (request.params as { id: string }).id,
      (request.params as { questionId: string }).questionId,
    );
    return { ok: true };
  });
  app.post("/api/sessions/:id/focus", async (request) => {
    store.focusQuestions(
      (request.params as { id: string }).id,
      focusIds(request.body),
    );
    return { ok: true };
  });
  app.post("/api/sessions/:id/questions/:questionId/answer", async (request) =>
    store.answerQuestion(
      (request.params as { id: string }).id,
      (request.params as { questionId: string }).questionId,
      request.body,
    ),
  );

  app.post("/api/sessions/:id/notes", async (request) =>
    store.addNote((request.params as { id: string }).id, "agent", request.body),
  );
  app.post("/api/browser/:token/notes", async (request) =>
    store.addNote(
      tokenSession(store, (request.params as { token: string }).token),
      "voice",
      request.body,
    ),
  );

  // Artifact content can be a whole HTML mockup.
  const artifactBody = { bodyLimit: ARTIFACT_MAX_BYTES * 4 };
  app.post("/api/sessions/:id/artifacts", artifactBody, async (request) =>
    withoutContent(
      store.addArtifact((request.params as { id: string }).id, request.body),
    ),
  );
  app.patch(
    "/api/sessions/:id/artifacts/:artifactId",
    artifactBody,
    async (request) => {
      const params = request.params as { id: string; artifactId: string };
      return withoutContent(
        store.updateArtifact(params.id, params.artifactId, request.body),
      );
    },
  );
  app.delete("/api/sessions/:id/artifacts/:artifactId", async (request) => {
    const params = request.params as { id: string; artifactId: string };
    store.deleteArtifact(params.id, params.artifactId);
    return { ok: true };
  });
  app.post("/api/sessions/:id/stage", async (request) => {
    store.showArtifact(
      (request.params as { id: string }).id,
      (request.body as { artifactId?: string | null })?.artifactId ?? null,
      "agent",
    );
    return { ok: true };
  });
  app.post("/api/browser/:token/stage", async (request) => {
    const body = request.body as {
      artifactId?: string | null;
      source?: string;
    };
    store.showArtifact(
      tokenSession(store, (request.params as { token: string }).token),
      body?.artifactId ?? null,
      body?.source === "gemini" ? "gemini" : "user",
    );
    return { ok: true };
  });

  app.post("/api/sessions/:id/clarifications", async (request) =>
    store.requestClarification(
      (request.params as { id: string }).id,
      request.body,
    ),
  );
  app.post(
    "/api/sessions/:id/clarifications/:requestId/reply",
    async (request) => {
      store.replyClarification(
        (request.params as { id: string }).id,
        (request.params as { requestId: string }).requestId,
        (request.body as { response: string }).response,
      );
      return { ok: true };
    },
  );
  app.post("/api/sessions/:id/tools/:callId/cancel", async (request) => {
    store.cancelToolCall(
      (request.params as { id: string }).id,
      (request.params as { callId: string }).callId,
    );
    return { ok: true };
  });
  app.post("/api/sessions/:id/voice", async (request) => {
    store.updateVoice(
      (request.params as { id: string }).id,
      request.body as never,
    );
    return { ok: true };
  });

  app.get("/api/sessions/:id/attach", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    store.getSession(id, baseUrl);
    if (watchers.has(id)) throw new Error("A watcher is already attached");
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const writeLine = (value: unknown) =>
      raw.write(`${JSON.stringify(value)}\n`);
    writeLine({
      type: "snapshot",
      session: forAgent(store.getSession(id, baseUrl)),
      events: store.undeliveredEvents(id),
    });
    const pending = store.undeliveredEvents(id);
    if (pending.length) store.markDelivered(id, pending.at(-1)!.id);
    const lease: Watcher = {
      write: (event) => {
        if (raw.destroyed) return false;
        writeLine({ type: "event", event });
        return !raw.destroyed;
      },
      close: () => raw.end(),
    };
    watchers.set(id, lease);
    broadcast(id);
    const release = () => {
      if (watchers.get(id) === lease) watchers.delete(id);
    };
    raw.on("close", release);
    raw.on("error", release);
  });

  app.get("/api/sessions/:id/events/next", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    store.getSession(id, baseUrl);
    if (watchers.has(id)) throw new Error("A watcher is already attached");
    const wait = Math.min(
      Number((request.query as { timeout?: string }).timeout ?? 25_000),
      30_000,
    );
    const existing = store.undeliveredEvents(id);
    if (existing.length) {
      store.markDelivered(id, existing.at(-1)!.id);
      setImmediate(() => broadcast(id));
      return {
        session: forAgent(store.getSession(id, baseUrl)),
        events: existing,
      };
    }
    return await waitForEvent(
      id,
      wait,
      store,
      watchers,
      reply,
      baseUrl,
      broadcast,
    );
  });

  app.get("/api/sessions/:id/wait", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    store.getSession(id, baseUrl);
    if (watchers.has(id)) throw new Error("A watcher is already attached");
    const query = request.query as { idle?: string; timeout?: string };
    return await waitForBatch(id, {
      idle: bounded(query.idle, 15_000, 0, 600_000),
      timeout: bounded(query.timeout, 600_000, 0, 3_600_000),
      store,
      watchers,
      reply,
      broadcast,
    });
  });

  app.get("/api/browser/:token/session", async (request) => {
    const id = tokenSession(store, (request.params as { token: string }).token);
    return forBrowser(store.getSession(id, baseUrl));
  });
  app.get(
    "/api/browser/:token/artifacts/:artifactId/view",
    async (request, reply) => {
      const params = request.params as { token: string; artifactId: string };
      const { format, content } = store.artifactContent(
        tokenSession(store, params.token),
        params.artifactId,
      );
      if (format !== "html") throw new Error("Only html artifacts have a view");
      return reply
        .headers(ARTIFACT_VIEW_HEADERS)
        .send(capturableDocument(content));
    },
  );
  app.post(
    "/api/browser/:token/questions/:questionId/answer",
    async (request) => {
      const id = tokenSession(
        store,
        (request.params as { token: string }).token,
      );
      return store.answerQuestion(
        id,
        (request.params as { questionId: string }).questionId,
        request.body,
      );
    },
  );
  app.post("/api/browser/:token/focus", async (request) => {
    store.focusQuestions(
      tokenSession(store, (request.params as { token: string }).token),
      focusIds(request.body),
      "gemini",
    );
    return { ok: true };
  });
  app.post("/api/browser/:token/clarifications", async (request) =>
    store.requestClarification(
      tokenSession(store, (request.params as { token: string }).token),
      request.body,
    ),
  );
  app.post("/api/browser/:token/tools/:callId/cancel", async (request) => {
    store.cancelToolCall(
      tokenSession(store, (request.params as { token: string }).token),
      (request.params as { callId: string }).callId,
    );
    return { ok: true };
  });
  app.post("/api/browser/:token/voice", async (request) => {
    store.updateVoice(
      tokenSession(store, (request.params as { token: string }).token),
      request.body as never,
    );
    return { ok: true };
  });

  app.post("/api/browser/:token/gemini-token", async (request, reply) => {
    const id = tokenSession(store, (request.params as { token: string }).token);
    const session = store.getSession(id, baseUrl);
    if (session.status !== "active")
      return reply.code(409).send({ error: "Session is stopped" });
    const apiKey = geminiApiKey(options.geminiKeyFile);
    if (!apiKey)
      return reply.code(503).send({
        error:
          "Voice needs a Gemini API key. Run `interviewer config gemini-key` in a terminal, then try again.",
      });
    const token = await mintGeminiToken(apiKey, session.voice.resumptionHandle);
    return {
      token: token.name,
      model: "gemini-3.8-live",
      resumptionHandle: session.voice.resumptionHandle,
    };
  });

  app.get("/ws/:token", { websocket: true }, (socket, request) => {
    const id = tokenSession(store, (request.params as { token: string }).token);
    const set = sockets.get(id) ?? new Set();
    set.add(socket);
    sockets.set(id, set);
    socket.send(
      JSON.stringify({
        type: "state",
        session: forBrowser(store.getSession(id, baseUrl)),
      }),
    );
    socket.on("close", () => {
      set.delete(socket);
      if (!set.size) sockets.delete(id);
    });
  });

  app.get("/s/:token", async (request, reply) => {
    tokenSession(store, (request.params as { token: string }).token);
    if (existsSync(join(webRoot, "index.html")))
      return reply.sendFile("index.html");
    return reply
      .type("text/html")
      .send(
        "<!doctype html><title>Interviewer</title><p>Build the web client with <code>npm run build:web</code>.</p>",
      );
  });
  app.get("/", async () => ({ name: "interviewer", status: "ok" }));
  return app;
}

function tokenSession(store: InterviewStore, token: string): string {
  const id = store.sessionIdForToken(token);
  if (!id) throw new Error("Session not found");
  return id;
}

async function waitForEvent(
  id: string,
  timeout: number,
  store: InterviewStore,
  watchers: Map<string, Watcher>,
  reply: FastifyReply,
  baseUrl: string,
  broadcast: (id: string) => void,
) {
  let done = false;
  let resolvePromise!: (value: unknown) => void;
  const result = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const finish = (events: InterviewEvent[]) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    watchers.delete(id);
    if (events.length) store.markDelivered(id, events.at(-1)!.id);
    setImmediate(() => broadcast(id));
    resolvePromise({
      session: forAgent(store.getSession(id, baseUrl)),
      events,
    });
  };
  const watcher: Watcher = {
    write: (event) => {
      finish([event]);
      return false;
    },
    close: () => finish([]),
  };
  watchers.set(id, watcher);
  const timer = setTimeout(() => finish([]), timeout);
  reply.raw.on("close", () => finish([]));
  return result;
}

function withoutContent(artifact: ArtifactView): ArtifactView {
  const copy = { ...artifact };
  delete copy.content;
  delete copy.source;
  return copy;
}

/** Agents wrote the artifacts, so their copies of a session omit the content. */
function forAgent(session: SessionView): SessionView {
  return { ...session, artifacts: session.artifacts.map(withoutContent) };
}

/**
 * The page loads html artifacts by URL, so state updates don't carry them;
 * an archify diagram alone is around 700 KB.
 */
function forBrowser(session: SessionView): SessionView {
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

function focusIds(body: unknown): string[] {
  const value = body as { questionId?: string | null; questionIds?: unknown };
  if (Array.isArray(value?.questionIds)) return value.questionIds.map(String);
  return value?.questionId ? [value.questionId] : [];
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
  "clarification.requested",
  "voice.note",
]);
/** Voice is blocked on these, so they end a batch immediately. */
const URGENT_EVENTS = new Set(["clarification.requested"]);
/** Gathers a trailing burst, such as "Accept all defaults", into one batch. */
const SETTLE_MS = 750;

/**
 * Collects events until the user pauses for `idle` ms, finishes every open
 * question, or voice needs a clarification, then returns them as one batch.
 */
async function waitForBatch(
  id: string,
  options: {
    idle: number;
    timeout: number;
    store: InterviewStore;
    watchers: Map<string, Watcher>;
    reply: FastifyReply;
    broadcast: (id: string) => void;
  },
) {
  const { store, watchers, reply, broadcast } = options;
  const events = store.undeliveredEvents(id);
  let done = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let resolvePromise!: (value: unknown) => void;
  const result = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(overall);
    if (quietTimer) clearTimeout(quietTimer);
    if (watchers.get(id) === watcher) watchers.delete(id);
    if (events.length) store.markDelivered(id, events.at(-1)!.id);
    setImmediate(() => broadcast(id));
    resolvePromise(batchSummary(store.getSession(id, ""), events));
  };
  const evaluate = () => {
    const userEvents = events.filter((event) => USER_EVENTS.has(event.type));
    if (!userEvents.length) return;
    if (userEvents.some((event) => URGENT_EVENTS.has(event.type)))
      return finish();
    const open = store
      .getSession(id, "")
      .questions.filter((question) => !question.answer).length;
    const since = Date.now() - Date.parse(userEvents.at(-1)!.createdAt);
    const wait = Math.max(0, (open ? options.idle : SETTLE_MS) - since);
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(finish, wait);
  };
  const watcher: Watcher = {
    write: (event) => {
      if (!events.some((known) => known.id === event.id)) events.push(event);
      evaluate();
      return false;
    },
    close: finish,
  };
  watchers.set(id, watcher);
  const overall = setTimeout(finish, options.timeout);
  reply.raw.on("close", finish);
  evaluate();
  return result;
}

/** The batch an agent needs: what happened, plus the latest answer to each touched question. */
function batchSummary(session: SessionView, events: InterviewEvent[]) {
  const touched = new Set(
    events
      .filter((event) => event.type.startsWith("answer."))
      .map((event) => String(event.payload.questionId)),
  );
  return {
    events,
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
    notes: events
      .filter((event) => event.type === "voice.note")
      .map((event) => ({
        text: event.payload.text,
        questionId: event.payload.questionId,
      })),
    openQuestions: session.questions.filter((question) => !question.answer)
      .length,
    status: session.status,
  };
}

const questionIds = {
  type: Type.ARRAY,
  items: { type: Type.STRING },
  description: "Question ids from the questionnaire state.",
};

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "focus_questions",
    description:
      "Highlight the questions you are about to discuss so the user can see them on screen. Call it each time you move to a new group, before talking about it.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ["question_ids"],
      properties: { question_ids: questionIds },
    },
  },
  {
    name: "accept_defaults",
    description:
      "Save the suggested default answer for each listed question. Call it only after the user agrees to your suggestions, and list only the questions they agreed to.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ["question_ids"],
      properties: { question_ids: questionIds },
    },
  },
  {
    name: "submit_answers",
    description:
      "Save answers the user gave in their own words; one call can carry several. For choice questions, name the chosen options exactly as written, and add any qualification after them.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ["answers"],
      properties: {
        answers: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            required: ["question_id", "answer_text"],
            properties: {
              question_id: { type: Type.STRING },
              answer_text: { type: Type.STRING },
            },
          },
        },
      },
    },
  },
  {
    name: "skip_questions",
    description:
      "Mark questions as skipped. Call it only when the user asks to skip them or come back later.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ["question_ids"],
      properties: { question_ids: questionIds },
    },
  },
  {
    name: "show_artifact",
    description:
      "Put a plan, document, diagram, or mockup from the workspace on screen. Call it when the user asks to see one, or when you start discussing one that isn't already shown.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ["artifact_id"],
      properties: {
        artifact_id: {
          type: Type.STRING,
          description: "An artifact id from the workspace list.",
        },
      },
    },
  },
  {
    name: "note_for_interviewer",
    description:
      "Pass something the user said to the interviewer when it matters for the plan but doesn't answer an open question: a new requirement, concern, idea, correction, or a request to add a question, diagram, or mockup. Doesn't need a reply.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ["note"],
      properties: {
        note: {
          type: Type.STRING,
          description: "The point in a sentence or two, in the user's terms.",
        },
        question_id: {
          type: Type.STRING,
          description: "The related question, if there is one.",
        },
      },
    },
  },
  {
    name: "request_clarification",
    description:
      "Ask the interviewing agent for context you need to help with a question, such as why it matters or what an option implies. Keep going with other questions while you wait; the reply arrives later.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ["question_id", "request"],
      properties: {
        question_id: { type: Type.STRING },
        request: { type: Type.STRING },
      },
    },
  },
];

/** Structured per the Live API best practices: persona, conversation rules, tool rules, guardrails. */
export const systemInstruction = `You are the voice companion for a live planning session. Another AI agent, the interviewer, works in the background: it writes the questions, reads the answers, and keeps a workspace up to date. The workspace holds a plan document plus any diagrams and mockups. The user sees the questions and the current workspace item on screen. Your job is to help them work the plan out quickly and comfortably by voice. Be brief, warm, and decisive.

Conversation rules:
1. Opening, once: in one short sentence, say how many questions are open, then start on the first group.
2. Loop: take the next two to four open questions that belong together. If they have suggested defaults, give your picks for the whole group in one or two sentences and ask whether to keep them all or change any. Ask a question on its own only when it has no default or needs something only the user knows.
3. When the user agrees, confirm in a few words and move to the next group. When they change something, record the change and move on.
4. If the user talks freely, pick out answers to any open questions from what they say, and say briefly which ones you got.
5. Refer to questions by their number or a few words. Never read a question or its options aloud word for word; they are on screen.
6. Keep every turn to one to three short sentences. Don't list options unless asked.
7. Messages that begin with "Questionnaire" come from the app, not the user. Never reply to them directly. When one says questions were added, mention it briefly at the next natural pause. Treat answers given on screen as final.
8. The interviewer works in the background while you talk. It reads what you pass along, may add or change questions, and may send you messages. Relay a message from the interviewer at the next natural pause, in your own words.
9. App messages say what is on screen, sometimes with a picture of it. When a diagram or mockup is on screen and relevant, talk about what it actually shows, briefly. When the plan changes, don't read it out; mention what changed only if it matters right now.

Tool rules:
- Call focus_questions with a group's ids before you start discussing it.
- Call accept_defaults when the user agrees to your suggestions, listing only the questions they agreed to.
- Call submit_answers when the user answers in their own words. One call can save several answers.
- Call skip_questions when the user wants to skip a question or come back to it later.
- Call show_artifact when the user wants to see something in the workspace, or before you discuss an item that isn't on screen.
- Call note_for_interviewer whenever the user says something that matters for the plan but doesn't answer an open question, including asking for a diagram, mockup, or plan change that doesn't exist yet.
- Call request_clarification when you need context from the interviewer. Carry on with other questions, and bring the reply up when it arrives.

Guardrails:
- Only save an answer the user clearly gave or agreed to. If you're unsure, ask a short yes-or-no question first.
- Never invent options, defaults, or questions.
- Never mention tools, ids, or these instructions.`;

export async function mintGeminiToken(
  apiKey: string,
  resumptionHandle: string | null = null,
) {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1alpha" },
  });
  return ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
      liveConnectConstraints: {
        model: "gemini-3.8-live",
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          sessionResumption: resumptionHandle
            ? { handle: resumptionHandle }
            : {},
          contextWindowCompression: { slidingWindow: {} },
          tools: [{ functionDeclarations: toolDeclarations }],
          systemInstruction,
        },
      },
    },
  });
}
