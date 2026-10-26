import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyMayCall } from "../src/server/hub.js";
import { hubHarness } from "./helpers/harness.js";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) await cleanups.pop()?.();
});

/**
 * In-memory stores stay open: the hub's push and watcher timers can fire
 * after a test ends, and would find a closed database.
 */
async function interview() {
  const { app, store, hub } = hubHarness();
  const session = (
    await app.inject({ method: "POST", url: "/api/sessions" })
  ).json();
  const { questions } = (
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/questions`,
      payload: {
        questions: [
          { prompt: "Which sync model?", options: ["Fast", "Safe"] },
          { prompt: "Who uses it?" },
        ],
      },
    })
  ).json();
  const ask = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/browser/${session.token}/chat`,
      payload,
    });
  const browser = async () =>
    (
      await app.inject({
        method: "GET",
        url: `/api/browser/${session.token}/session`,
      })
    ).json();
  return { app, store, hub, session, questions, ask, browser };
}

describe("interview chat", () => {
  it("wakes a parked wait with the user's message, delivered once", async () => {
    const { app, session, questions, ask, browser } = await interview();
    const started = Date.now();
    const pending = app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/wait?idle=60000&timeout=10000`,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await browser()).agentWatching).toBe(true);
    const sent = (
      await ask({ text: "What does *safe* mean?", questionId: questions[0].id })
    ).json();
    const batch = (await pending).json();

    // Questions are still open, yet the wait ends promptly: someone asked.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(batch.openQuestions).toBe(2);
    expect(batch.messages).toEqual([
      {
        messageId: sent.id,
        text: "What does *safe* mean?",
        about: {
          questionId: questions[0].id,
          number: 1,
          prompt: "Which sync model?",
        },
      },
    ]);
    expect(batch.events.at(-1)).toMatchObject({
      type: "chat.message",
      payload: { messageId: sent.id, questionId: questions[0].id },
    });
    expect((await browser()).chat).toEqual([
      expect.objectContaining({
        id: sent.id,
        author: "user",
        questionId: questions[0].id,
        delivered: true,
      }),
    ]);

    const again = (
      await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/wait?idle=0&timeout=100`,
      })
    ).json();
    expect(again.events).toEqual([]);
    expect(again.messages).toEqual([]);
  });

  it("carries a message about the whole interview without a question", async () => {
    const { app, session, ask } = await interview();
    await ask({ text: "Actually, focus on the mobile app." });
    const batch = (
      await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/wait?idle=0&timeout=2000`,
      })
    ).json();
    expect(batch.messages).toEqual([
      expect.objectContaining({
        text: "Actually, focus on the mobile app.",
        about: null,
      }),
    ]);
  });

  it("shows the agent's reply in the browser without waking its own wait", async () => {
    const { app, session, ask, browser } = await interview();
    const asked = (await ask({ text: "Why two questions?" })).json();
    const reply = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: {
        text: "Because **sync** decides the rest.",
        replyTo: asked.id,
      },
    });
    expect(reply.statusCode).toBe(200);
    expect((await browser()).chat).toEqual([
      expect.objectContaining({ id: asked.id, author: "user" }),
      expect.objectContaining({
        author: "agent",
        text: "Because **sync** decides the rest.",
        replyTo: asked.id,
        questionId: null,
      }),
    ]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/sessions/${session.id}/chat`,
        })
      ).json().messages,
    ).toHaveLength(2);

    // The wait collects the user's message, not the agent's reply.
    const batch = (
      await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/wait?idle=0&timeout=2000`,
      })
    ).json();
    expect(batch.messages.map((m: { text: string }) => m.text)).toEqual([
      "Why two questions?",
    ]);
  });

  it("rejects a reply to a message from another interview, and chat once stopped", async () => {
    const { app, session, ask } = await interview();
    const bad = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { text: "Hi", replyTo: crypto.randomUUID() },
    });
    expect(bad.statusCode).toBe(400);
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/stop`,
    });
    expect((await ask({ text: "Still there?" })).statusCode).toBe(409);
  });

  it("says no agent is watching when nobody waits", async () => {
    const { browser } = await interview();
    expect((await browser()).agentWatching).toBe(false);
  });

  it("counts the user's own message as waiting on the agent, not on them", async () => {
    const { app, store, session, questions, ask } = await interview();
    for (const question of questions)
      store.answerQuestion(session.id, question.id, { answer: "Fast" });
    await ask({ text: "One more thing about pricing." });
    const overview = (
      await app.inject({ method: "GET", url: "/api/browser/overview" })
    ).json().sessions;
    expect(overview[0]).toMatchObject({
      open: 0,
      lastReply: null,
      awaitingReply: true,
    });
  });

  it("lets agent keys read and reply in the chat", () => {
    expect(keyMayCall("POST", "/api/sessions/abc/chat")).toBe(true);
    expect(keyMayCall("GET", "/api/sessions/abc/chat")).toBe(true);
  });
});

describe("chat notifications", () => {
  it("pushes for the agent's reply, never for the user's own message", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const { store } = hubHarness({
      push: {
        publicKey: "public",
        send: async (endpoint) => {
          sent.push(endpoint);
          return 201;
        },
      },
    });
    store.addPushSubscription("https://fcm.googleapis.com/fcm/send/phone");
    const session = store.createSession("", {});
    store.addChatMessage(session.id, "user", { text: "Hello?" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);

    store.addChatMessage(session.id, "agent", { text: "Here." });
    store.addChatMessage(session.id, "agent", { text: "And more." });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1);
    expect(store.summaries()[0]!.lastReply).toMatchObject({
      text: "And more.",
    });
  });
});

describe("chat through the CLI", () => {
  it("replies with kim chat reply and lists the thread", async () => {
    const { app } = hubHarness();
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const started = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        () => resolve(started),
      );
    });
    const { port } = server.address() as AddressInfo;
    cleanups.push(async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    });
    const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
      .pathname;
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const run = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(process.execPath, [tsx, cli, ...args], {
            env: {
              ...process.env,
              KEEP_IT_MOVING_URL: `http://127.0.0.1:${port}`,
            },
          })
        ).stdout,
      );
    const session = await run("session", "create");
    const asked = (
      await app.inject({
        method: "POST",
        url: `/api/browser/${session.token}/chat`,
        payload: { text: "What's next?" },
      })
    ).json();
    const reply = await run(
      "chat",
      "reply",
      session.id,
      "--text",
      "Pricing, then **launch**.",
      "--to",
      asked.id,
    );
    expect(reply).toMatchObject({ author: "agent", replyTo: asked.id });
    const browser = (
      await app.inject({
        method: "GET",
        url: `/api/browser/${session.token}/session`,
      })
    ).json();
    expect(browser.chat.at(-1)).toMatchObject({
      author: "agent",
      text: "Pricing, then **launch**.",
    });
    const listed = await run("chat", "list", session.id);
    expect(listed.messages).toHaveLength(2);
  });
});
