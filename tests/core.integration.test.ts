import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubHarness } from "./helpers/harness.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function harness(path = ":memory:") {
  const { app, store, sql } = hubHarness({ path });
  cleanups.push(() => sql.close());
  return { app, store };
}

async function createQuestion(app: ReturnType<typeof hubHarness>["app"]) {
  const session = (
    await app.inject({ method: "POST", url: "/api/sessions" })
  ).json();
  const created = (
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/questions`,
      payload: {
        prompt: "Which direction?",
        type: "single-choice",
        options: ["A", "B"],
        recommendation: "Choose **A**.",
      },
    })
  ).json();
  return { session, question: created.questions[0] };
}

describe("interview HTTP seam", () => {
  it("creates a session with an interview title", async () => {
    const { app } = await harness();
    const session = (
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Todo list product interview" },
      })
    ).json();
    expect(session.title).toBe("Todo list product interview");
  });

  it("starts with the workspace closed and lets agent and user open it", async () => {
    const { app } = await harness();
    const closed = (
      await app.inject({ method: "POST", url: "/api/sessions", payload: {} })
    ).json();
    expect(closed.stageVisible).toBe(false);
    const open = (
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { stageVisible: true },
      })
    ).json();
    expect(open).toMatchObject({
      stageVisible: true,
      stageVisibilitySource: "agent",
    });

    await app.inject({
      method: "POST",
      url: `/api/sessions/${closed.id}/stage/visibility`,
      payload: { visible: true },
    });
    await app.inject({
      method: "POST",
      url: `/api/browser/${closed.token}/stage/visibility`,
      payload: { visible: false },
    });
    const state = (
      await app.inject({ method: "GET", url: `/api/sessions/${closed.id}` })
    ).json();
    expect(state).toMatchObject({
      stageVisible: false,
      stageVisibilitySource: "user",
    });
    const batch = (
      await app.inject({
        method: "GET",
        url: `/api/sessions/${closed.id}/wait?timeout=1`,
      })
    ).json();
    expect(
      batch.events
        .filter((event: { type: string }) => event.type === "stage.visibility")
        .map((event: { payload: unknown }) => event.payload),
    ).toEqual([
      { visible: true, source: "agent" },
      { visible: false, source: "user" },
    ]);
    expect(batch.stageVisible).toBe(false);
  });

  it("chains partial waits without losing queued events", async () => {
    const { app } = await harness();
    const { session } = await createQuestion(app);
    const partial = (
      await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/wait?timeout=20&partial=1`,
      })
    ).json();
    expect(partial).toEqual({ partial: true });
    const final = (
      await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/wait?timeout=20`,
      })
    ).json();
    expect(final.events.map((event: { type: string }) => event.type)).toEqual([
      "session.created",
      "question.added",
    ]);
  });

  it("persists revisions and changes the receipt only after delivery", async () => {
    const { app } = await harness();
    const { session, question } = await createQuestion(app);
    await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/events/next?timeout=1`,
    });

    const first = await app.inject({
      method: "POST",
      url: `/api/browser/${session.token}/questions/${question.id}/answer`,
      payload: { answer: "A" },
    });
    expect(first.statusCode).toBe(200);
    let state = (
      await app.inject({
        method: "GET",
        url: `/api/browser/${session.token}/session`,
      })
    ).json();
    expect(state.questions[0].answer).toMatchObject({
      text: "A",
      revision: 1,
      delivered: false,
    });

    const delivery = (
      await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/events/next?timeout=1`,
      })
    ).json();
    expect(
      delivery.events.map((event: { type: string }) => event.type),
    ).toContain("answer.submitted");
    state = (
      await app.inject({
        method: "GET",
        url: `/api/browser/${session.token}/session`,
      })
    ).json();
    expect(state.questions[0].answer.delivered).toBe(true);

    await app.inject({
      method: "POST",
      url: `/api/browser/${session.token}/questions/${question.id}/answer`,
      payload: { answer: "Something else" },
    });
    state = (
      await app.inject({
        method: "GET",
        url: `/api/browser/${session.token}/session`,
      })
    ).json();
    expect(state.questions[0].answer).toMatchObject({
      text: "Something else",
      revision: 2,
      delivered: false,
    });
  });

  it("keeps a question's type and options when an update omits them", async () => {
    const { app } = await harness();
    const { session, question } = await createQuestion(app);
    const updated = (
      await app.inject({
        method: "PATCH",
        url: `/api/sessions/${session.id}/questions/${question.id}`,
        payload: { prompt: "Which direction now?" },
      })
    ).json();
    expect(updated).toMatchObject({
      prompt: "Which direction now?",
      type: "single-choice",
      options: ["A", "B"],
    });
  });

  it("stores defaults in canonical option spelling and rejects unknown options", async () => {
    const { app } = await harness();
    const session = (
      await app.inject({ method: "POST", url: "/api/sessions" })
    ).json();
    const add = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/questions`,
        payload,
      });
    const created = (
      await add({
        questions: [
          { type: "yes-no", prompt: "Ship it?", default: "yes" },
          {
            type: "multiple-choice",
            prompt: "Platforms?",
            options: ["iOS", "Web", "Android"],
            default: ["web", "iOS"],
          },
          { type: "number", prompt: "Price?", default: 6 },
          { type: "text", prompt: "Why?" },
        ],
      })
    ).json();
    expect(
      created.questions.map((q: { default: unknown }) => q.default),
    ).toEqual([["Yes"], ["iOS", "Web"], ["6"], null]);

    const unknown = await add({
      type: "single-choice",
      prompt: "Pick",
      options: ["A", "B"],
      default: "C",
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain('Default "C" is not one of');

    const several = await add({
      type: "single-choice",
      prompt: "Pick",
      options: ["A", "B"],
      default: ["A", "B"],
    });
    expect(several.statusCode).toBe(400);

    const staleDefault = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/questions/${created.questions[1].id}`,
      payload: { options: ["Android"] },
    });
    expect(staleDefault.statusCode).toBe(400);
  });

  it("batches answers into one wait result once the user pauses", async () => {
    const { app } = await harness();
    const session = (
      await app.inject({ method: "POST", url: "/api/sessions" })
    ).json();
    const { questions } = (
      await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/questions`,
        payload: {
          questions: [
            { type: "yes-no", prompt: "One?", default: "Yes" },
            { type: "text", prompt: "Two?" },
            { type: "text", prompt: "Three?" },
          ],
        },
      })
    ).json();
    const answer = (id: string, text: string) =>
      app.inject({
        method: "POST",
        url: `/api/browser/${session.token}/questions/${id}/answer`,
        payload: { answer: text },
      });

    const started = Date.now();
    const pending = app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/wait?idle=300&timeout=5000`,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await answer(questions[0].id, "Yes");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await answer(questions[1].id, "Fast sync");
    const batch = (await pending).json();

    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(batch.answers).toEqual([
      expect.objectContaining({
        number: 1,
        answer: "Yes",
        acceptedDefault: true,
      }),
      expect.objectContaining({
        number: 2,
        answer: "Fast sync",
        acceptedDefault: false,
      }),
    ]);
    expect(batch.openQuestions).toBe(1);
    // The agent's own question.added events ride along without waking the wait.
    expect(batch.events.map((event: { type: string }) => event.type)).toEqual([
      "session.created",
      "question.added",
      "question.added",
      "question.added",
      "answer.submitted",
      "answer.submitted",
    ]);
  });

  it("ends a wait promptly when nothing is left open", async () => {
    const { app } = await harness();
    const { session, question } = await createQuestion(app);
    const wait = () =>
      app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/wait?idle=60000&timeout=10000`,
      });

    const started = Date.now();
    const pending = wait();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.inject({
      method: "POST",
      url: `/api/browser/${session.token}/questions/${question.id}/answer`,
      payload: { answer: "A" },
    });
    expect((await pending).json().openQuestions).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("focuses a group of questions and drops deleted ones from it", async () => {
    const { app } = await harness();
    const { session, question } = await createQuestion(app);
    const second = (
      await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/questions`,
        payload: { prompt: "Second" },
      })
    ).json().questions[0];
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/focus`,
      payload: { questionIds: [question.id, second.id] },
    });
    const show = async () =>
      (
        await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })
      ).json();
    expect(await show()).toMatchObject({
      focusedQuestionId: question.id,
      focusedQuestionIds: [question.id, second.id],
    });
    await app.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}/questions/${question.id}`,
    });
    expect(await show()).toMatchObject({
      focusedQuestionId: second.id,
      focusedQuestionIds: [second.id],
    });
  });

  it("keeps one plan, stages artifacts, and leaves content out of agent views", async () => {
    const { app } = await harness();
    const session = (
      await app.inject({ method: "POST", url: "/api/sessions" })
    ).json();
    const add = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/artifacts`,
        payload,
      });
    const plan = (
      await add({ kind: "plan", title: "Plan", content: "# v1" })
    ).json();
    const replaced = (
      await add({ kind: "plan", title: "Plan", content: "# v1\n- sync" })
    ).json();
    expect(replaced).toMatchObject({ id: plan.id, revision: 2 });
    expect(replaced).not.toHaveProperty("content");

    const mockup = "<main>" + "x".repeat(1_500_000) + "</main>";
    const layout = await add({
      kind: "mockup",
      title: "Layout A",
      content: mockup,
      description: "Sidebar layout",
      show: true,
    });
    expect(layout.statusCode).toBe(200);

    const agentView = (
      await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })
    ).json();
    expect(agentView.stage).toEqual({
      artifactId: layout.json().id,
      source: "agent",
    });
    expect(
      agentView.artifacts.map((artifact: Record<string, unknown>) => [
        artifact.kind,
        "content" in artifact,
        artifact.size,
      ]),
    ).toEqual([
      ["plan", false, "# v1\n- sync".length],
      ["mockup", false, mockup.length],
    ]);
    const served = await app.inject({
      method: "GET",
      url: `/api/browser/${session.token}/artifacts/${layout.json().id}/view`,
    });
    expect(served.body.startsWith(mockup)).toBe(true);

    await app.inject({
      method: "POST",
      url: `/api/browser/${session.token}/stage`,
      payload: { artifactId: plan.id },
    });
    await app.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}/artifacts/${plan.id}`,
    });
    const afterDelete = (
      await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })
    ).json();
    expect(afterDelete.stage).toBeNull();
    expect(afterDelete.artifacts).toHaveLength(1);
  });

  it("serves html artifacts from a sandboxed URL instead of in state", async () => {
    const { app } = await harness();
    const session = (
      await app.inject({ method: "POST", url: "/api/sessions" })
    ).json();
    const add = async (payload: Record<string, unknown>) =>
      (
        await app.inject({
          method: "POST",
          url: `/api/sessions/${session.id}/artifacts`,
          payload,
        })
      ).json();
    const diagram = await add({
      kind: "diagram",
      title: "Sync",
      content: "<!doctype html><html><body><svg></svg></body></html>",
      source: '{"diagram_type":"architecture"}',
    });
    const svg = await add({
      kind: "diagram",
      title: "Raw",
      content: "<svg viewBox='0 0 10 10'></svg>",
    });
    expect([diagram.format, svg.format]).toEqual(["html", "svg"]);

    const view = await app.inject({
      method: "GET",
      url: `/api/browser/${session.token}/artifacts/${diagram.id}/view?embed=1`,
    });
    expect(view.headers["content-security-policy"]).toBe(
      "sandbox allow-scripts",
    );
    expect(view.headers["referrer-policy"]).toBe("no-referrer");
    expect(view.body).toBe(
      "<!doctype html><html><body><svg></svg></body></html>",
    );
    const notHtml = await app.inject({
      method: "GET",
      url: `/api/browser/${session.token}/artifacts/${svg.id}/view`,
    });
    expect(notHtml.statusCode).toBe(400);

    const browser = (
      await app.inject({
        method: "GET",
        url: `/api/browser/${session.token}/session`,
      })
    ).json();
    expect(
      browser.artifacts.map((item: Record<string, unknown>) => [
        "content" in item,
        item.source,
      ]),
    ).toEqual([
      [false, '{"diagram_type":"architecture"}'],
      [true, null],
    ]);
    const agent = (
      await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })
    ).json();
    expect(
      agent.artifacts.map(
        (item: Record<string, unknown>) =>
          "content" in item || "source" in item,
      ),
    ).toEqual([false, false]);
  });

  it("links questions to artifacts and shows the artifact when focused", async () => {
    const { app, store } = await harness();
    const session = (
      await app.inject({ method: "POST", url: "/api/sessions" })
    ).json();
    const artifact = async (title: string) =>
      (
        await app.inject({
          method: "POST",
          url: `/api/sessions/${session.id}/artifacts`,
          payload: { kind: "mockup", title, content: `<p>${title}</p>` },
        })
      ).json().id;
    const [diagram, a, b] = [
      await artifact("Architecture"),
      await artifact("A"),
      await artifact("B"),
    ];
    const add = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/questions`,
        payload,
      });
    const badLabel = await add({
      type: "single-choice",
      prompt: "Layout?",
      options: ["Sidebar", "Board"],
      optionArtifacts: { Tabs: a },
    });
    expect(badLabel.json().error).toContain('"Tabs", which is not an option');
    const missing = await add({
      prompt: "About?",
      artifactId: "00000000-0000-4000-8000-000000000000",
    });
    expect(missing.statusCode).toBe(400);

    const question = (
      await add({
        type: "single-choice",
        prompt: "Layout?",
        artifactId: diagram,
        options: ["Sidebar", "Board"],
        optionArtifacts: { Sidebar: a, Board: b },
      })
    ).json().questions[0];
    expect(question.optionArtifacts).toEqual({ Sidebar: a, Board: b });

    store.focusQuestions(session.id, [question.id]);
    const state = (
      await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })
    ).json();
    expect(state.stage).toEqual({ artifactId: diagram, source: "agent" });

    const renamed = (
      await app.inject({
        method: "PATCH",
        url: `/api/sessions/${session.id}/questions/${question.id}`,
        payload: { options: ["Sidebar", "Tabs"] },
      })
    ).json();
    expect(renamed.optionArtifacts).toEqual({ Sidebar: a });
  });

  it("supports skip, edit, delete, stop and resume without automatic invalidation", async () => {
    const { app } = await harness();
    const { session, question } = await createQuestion(app);
    await app.inject({
      method: "POST",
      url: `/api/browser/${session.token}/questions/${question.id}/answer`,
      payload: { answer: "", skipped: true },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/questions/${question.id}`,
      payload: { options: ["C", "D"] },
    });
    let state = (
      await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })
    ).json();
    expect(state.questions[0].answer.skipped).toBe(true);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/sessions/${session.id}/stop`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/browser/${session.token}/questions/${question.id}/answer`,
          payload: { answer: "C" },
        })
      ).statusCode,
    ).toBe(409);
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/resume`,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/browser/${session.token}/questions/${question.id}/answer`,
          payload: { answer: "C" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/browser/${session.token}/questions/${question.id}/answer`,
          payload: { answer: "" },
        })
      ).statusCode,
    ).toBe(400);
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/focus`,
      payload: { questionId: question.id },
    });
    await app.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}/questions/${question.id}`,
    });
    state = (
      await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })
    ).json();
    expect(state.questions).toEqual([]);
    expect(state.focusedQuestionId).toBeNull();
    const events = (
      await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/events/next?timeout=1`,
      })
    ).json().events;
    expect(events.map((event: { type: string }) => event.type)).toContain(
      "question.deleted",
    );
  });
});

describe("SQLite restart seam", () => {
  it("restores sessions and questions after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "interviewer-"));
    const path = join(dir, "state.sqlite");
    const first = await harness(path);
    const { session, question } = await createQuestion(first.app);
    await first.app.inject({
      method: "POST",
      url: `/api/browser/${session.token}/questions/${question.id}/answer`,
      payload: { answer: "Persistent" },
    });
    await cleanups.pop()?.();

    const second = await harness(path);
    const state = (
      await second.app.inject({
        method: "GET",
        url: `/api/browser/${session.token}/session`,
      })
    ).json();
    expect(state.questions[0].answer.text).toBe("Persistent");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  });
});
