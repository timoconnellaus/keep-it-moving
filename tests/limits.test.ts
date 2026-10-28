import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "../src/server/store.js";
import { hubHarness } from "./helpers/harness.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup() {
  const harness = hubHarness();
  cleanups.push(() => harness.sql.close());
  return harness;
}

describe("workspace limits", () => {
  it("caps the interviews in a workspace, with a clear 403", async () => {
    const { app, store, sql } = setup();
    // Rows straight into the table: creating each through the store is slow.
    for (let index = 1; index < LIMITS.interviews; index++)
      sql.all(
        "INSERT INTO sessions (id, token, created_at, updated_at) VALUES (?, ?, '', '')",
        `seeded-${index}`,
        `token-${index}`,
      );
    store.createSession("", { title: "The last one" });
    const refused = await app.inject({ method: "POST", url: "/api/sessions" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/at most 500 interviews/);
    // Deleting one makes room again.
    store.deleteSession("seeded-1");
    expect(
      (await app.inject({ method: "POST", url: "/api/sessions" })).statusCode,
    ).toBe(200);
  });

  it("caps questions per interview, counting a batch as a whole", async () => {
    const { app, store } = setup();
    const session = store.createSession("", {});
    const questions = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        type: "text",
        prompt: `Question ${index}?`,
      }));
    store.addQuestions(session.id, questions(LIMITS.questions - 1));
    const refused = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/questions`,
      payload: questions(2),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/at most 200 questions/);
    expect(store.addQuestions(session.id, questions(1))).toHaveLength(1);
  });

  it("caps artifacts per interview, but a plan can still be replaced", () => {
    const { store } = setup();
    const session = store.createSession("", {});
    store.addArtifact(session.id, {
      kind: "plan",
      title: "Plan",
      content: "v1",
    });
    for (let index = 1; index < LIMITS.artifacts; index++)
      store.addArtifact(session.id, {
        kind: "document",
        title: `Doc ${index}`,
        content: "x",
      });
    expect(() =>
      store.addArtifact(session.id, {
        kind: "document",
        title: "One more",
        content: "x",
      }),
    ).toThrow(/at most 50 artifacts/);
    expect(
      store.addArtifact(session.id, {
        kind: "plan",
        title: "Plan",
        content: "v2",
      }).revision,
    ).toBe(2);
  });

  it("caps chat messages per interview", () => {
    const { store, sql } = setup();
    const session = store.createSession("", {});
    for (let index = 1; index < LIMITS.chatMessages; index++)
      sql.all(
        "INSERT INTO chat_messages (id, session_id, author, text, created_at) VALUES (?, ?, 'agent', 'x', '')",
        `seeded-${index}`,
        session.id,
      );
    store.addChatMessage(session.id, "user", { text: "The last one" });
    expect(() =>
      store.addChatMessage(session.id, "user", { text: "One more" }),
    ).toThrow(/at most 2000 messages/);
  });
});
