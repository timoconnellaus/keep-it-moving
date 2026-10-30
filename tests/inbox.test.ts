import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRAFTER_HEADER,
  RESPONDENT_HEADER,
  type BrowserSockets,
} from "../src/server/hub.js";
import { composeParts } from "../src/shared/answers.js";
import type { QuestionView } from "../src/shared/schema.js";
import { hubHarness } from "./helpers/harness.js";

afterEach(() => vi.useRealTimers());

const MOCKUP = `<!doctype html><html><head><style>:root { --accent: blue; }</style></head><body><h1 data-kim-text="headline">Hello</h1></body></html>`;

/**
 * Ann's interview assigned to Bob, with a mockup and three questions; the
 * last is bound to the mockup. Requests come as Bob's agent (through the
 * Worker's inbox routes), Bob's browser, or Ann's.
 */
function harness() {
  const owner: string[] = [];
  const respondent: string[] = [];
  const sockets: BrowserSockets = {
    send: (_id, data) => owner.push(data),
    sendRespondent: (_id, data) => respondent.push(data),
    sendAll: () => undefined,
  };
  const result = hubHarness({ sockets });
  const { store } = result;
  const session = store.createSession("", { title: "Venue survey" });
  const mockup = store.addArtifact(session.id, {
    kind: "mockup",
    title: "Layout A",
    content: MOCKUP,
  });
  const questions = store.addQuestions(session.id, [
    { prompt: "Which room?", type: "single-choice", options: ["Big", "Small"] },
    { prompt: "How many guests?", type: "number", min: 1, max: 200 },
    {
      prompt: "Headline?",
      type: "text",
      artifactId: mockup.id,
      control: "#headline",
    },
  ]);
  store.assignSession(session.id, "bob@example.com", "Ann");
  const agentHeaders = {
    [RESPONDENT_HEADER]: "bob@example.com",
    [DRAFTER_HEADER]: "bob.work@example.com",
  };
  const asAgent = (method: string, path: string, payload?: unknown) =>
    result.app.inject({
      method,
      url: `/api/inbox/${session.token}${path}`,
      payload,
      headers: agentHeaders,
    });
  const asBob = (method: string, path: string, payload?: unknown) =>
    result.app.inject({
      method,
      url: `/api/browser/${session.token}${path}`,
      payload,
      headers: { [RESPONDENT_HEADER]: "bob@example.com" },
    });
  const asAnn = (method: string, path: string, payload?: unknown) =>
    result.app.inject({
      method,
      url: `/api/browser/${session.token}${path}`,
      payload,
    });
  return {
    ...result,
    session,
    mockup,
    questions,
    asAgent,
    asBob,
    asAnn,
    agentHeaders,
    sent: { owner, respondent },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("the assignee's agent in the owner's hub", () => {
  it("comes only through the Worker, as the assignee, for that interview", async () => {
    const { app, session, store, sql } = harness();
    const other = store.createSession("", { title: "Private" });
    const get = (url: string, headers: Record<string, string>) =>
      app.inject({ method: "GET", url, headers });
    // The browser assignee's header alone doesn't open the agent's routes.
    for (const headers of [
      {},
      { [RESPONDENT_HEADER]: "bob@example.com" },
      { [DRAFTER_HEADER]: "bob@example.com" },
    ])
      expect(
        (await get(`/api/inbox/${session.token}`, headers)).statusCode,
      ).toBe(403);
    const both = {
      [RESPONDENT_HEADER]: "bob@example.com",
      [DRAFTER_HEADER]: "bob@example.com",
    };
    expect((await get(`/api/inbox/${session.token}`, both)).statusCode).toBe(
      200,
    );
    // Not another interview, not someone it wasn't sent to, nothing else.
    expect((await get(`/api/inbox/${other.token}`, both)).statusCode).toBe(403);
    expect(
      (
        await get(`/api/inbox/${session.token}`, {
          [RESPONDENT_HEADER]: "carol@example.com",
          [DRAFTER_HEADER]: "carol@example.com",
        })
      ).statusCode,
    ).toBe(403);
    for (const [method, url] of [
      ["GET", `/api/sessions/${session.id}`],
      ["POST", `/api/sessions/${session.id}/questions`],
      ["POST", `/api/sessions/${session.id}/artifacts`],
      ["POST", `/api/browser/${session.token}/assign`],
    ] as const)
      expect(
        (
          await app.inject({
            method,
            url,
            headers: both,
            ...(method === "POST" ? { payload: {} } : {}),
          })
        ).statusCode,
        url,
      ).toBe(403);
    await settle();
    sql.close();
  });

  it("reads everything it needs to answer, by question number or id", async () => {
    const { asAgent, asBob, questions, mockup, sql } = harness();
    await asBob("POST", "/chat", {
      text: "Does Big have parking?",
      questionId: questions[0]!.id,
    });
    const view = (await asAgent("GET", "")).json();
    expect(view).toMatchObject({
      title: "Venue survey",
      from: "Ann",
      sentTo: "bob@example.com",
      openQuestions: 3,
      drafted: 0,
    });
    expect(view.questions[0]).toMatchObject({
      number: 1,
      type: "single-choice",
      options: ["Big", "Small"],
      answer: null,
      draft: null,
      thread: [
        expect.objectContaining({
          from: "bob@example.com",
          text: "Does Big have parking?",
        }),
      ],
    });
    expect(view.questions[1]).toMatchObject({ min: 1, max: 200 });
    expect(view.questions[2]).toMatchObject({
      artifact: { id: mockup.id, title: "Layout A", revision: 1 },
      control: "#headline",
    });
    expect(view.artifacts[0]).toMatchObject({
      id: mockup.id,
      kind: "mockup",
      format: "html",
      revision: 1,
      frame: { width: 1280, height: 800 },
    });
    // Html comes by its own route.
    expect(view.artifacts[0].content).toBeUndefined();
    await settle();
    sql.close();
  });

  it("serves an artifact as its frame does, with saved answers applied", async () => {
    const { asAgent, store, session, questions, mockup, sql } = harness();
    store.answerQuestion(session.id, questions[2]!.id, { answer: "Welcome" });
    const served = (await asAgent("GET", `/artifacts/${mockup.id}`)).json();
    expect(served).toMatchObject({ id: mockup.id, revision: 1 });
    expect(served.content).toContain('data-kim-text="headline">Welcome</h1>');
    expect(served.content).toContain("<script>");
    await settle();
    sql.close();
  });
});

describe("drafts", () => {
  it("are invisible to the owner: no event, no batch, not in their view", async () => {
    const { asAgent, asAnn, store, session, questions, sent, sql } = harness();
    await settle();
    sent.owner.length = 0;
    const before = store.undeliveredEvents(session.id).length;
    const drafted = await asAgent("PUT", "/questions/1/draft", {
      answer: "big",
    });
    expect(drafted.statusCode).toBe(200);
    expect(drafted.json()).toMatchObject({
      question: { id: questions[0]!.id, number: 1 },
      draft: { text: "Big", draftedBy: "bob.work@example.com" },
      url: expect.stringContaining(`/s/${session.token}`),
    });
    await settle();
    expect(store.undeliveredEvents(session.id)).toHaveLength(before);
    expect(store.getSession(session.id, "").questions[0]!.answer).toBeNull();
    const ownerView = (await asAnn("GET", "/session")).json();
    expect(ownerView.drafts).toBeUndefined();
    expect(JSON.stringify(ownerView)).not.toContain("bob.work");
    // Only the assignee's pages heard about it, live.
    expect(sent.owner).toEqual([]);
    expect(JSON.parse(sent.respondent.at(-1)!).session.drafts).toMatchObject({
      [questions[0]!.id]: { text: "Big" },
    });
    await settle();
    sql.close();
  });

  it("show prefilled in the assignee's view, and clear", async () => {
    const { asAgent, asBob, questions, sql } = harness();
    await asAgent("PUT", `/questions/${questions[1]!.id}/draft`, {
      answer: "40",
    });
    expect((await asBob("GET", "/session")).json().drafts).toMatchObject({
      [questions[1]!.id]: { text: "40", skipped: false },
    });
    expect(
      (await asAgent("DELETE", "/questions/2/draft")).json(),
    ).toMatchObject({ cleared: true });
    expect((await asBob("GET", "/session")).json().drafts).toEqual({});
    await settle();
    sql.close();
  });

  it("are checked like the form checks an answer", async () => {
    const { asAgent, sql } = harness();
    for (const [question, body, error] of [
      ["1", { answer: "Huge" }, /not one of the options: Big, Small/],
      ["1", { options: ["Big", "Small"] }, /takes one option/],
      ["2", { answer: "lots" }, /isn't a number/],
      ["2", { answer: "500" }, /above the maximum, 200/],
      ["2", { answer: "40", note: "roughly" }, /no options or note/],
      ["3", {}, /answer is required/],
      ["9", { answer: "x" }, /not found/i],
    ] as const) {
      const response = await asAgent(
        "PUT",
        `/questions/${question}/draft`,
        body,
      );
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.json().error).toMatch(error);
    }
    await settle();
    sql.close();
  });

  it("send once from the browser, as the assignee, leaving edited ones", async () => {
    const { asAgent, asBob, app, store, session, questions, sql } = harness();
    await asAgent("PUT", "/questions/1/draft", {
      options: ["Small"],
      note: "quieter",
    });
    await asAgent("PUT", "/questions/2/draft", { answer: "40" });
    await asAgent("PUT", "/questions/3/draft", { skipped: true });
    const sentDrafts = await asBob("POST", "/drafts/send", {
      questionIds: [questions[0]!.id, questions[2]!.id],
    });
    expect(sentDrafts.json()).toEqual({ sent: 2 });
    // Again: nothing left to send.
    expect(
      (
        await asBob("POST", "/drafts/send", {
          questionIds: [questions[0]!.id, questions[2]!.id],
        })
      ).json(),
    ).toEqual({ sent: 0 });
    const view = store.getSession(session.id, "");
    expect(view.questions[0]!.answer).toMatchObject({
      text: "Small — quieter",
      answeredBy: "bob@example.com",
      revision: 1,
    });
    expect(view.questions[2]!.answer).toMatchObject({ skipped: true });
    expect(view.questions[1]!.answer).toBeNull();
    expect(store.drafts(session.id)).toHaveProperty(questions[1]!.id);
    // The owner's agent gets them once, with nothing to say an agent wrote them.
    const batch = (
      await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/wait?idle=0&timeout=1000`,
      })
    ).json();
    expect(batch.answers).toEqual([
      expect.objectContaining({
        answer: "Small — quieter",
        answeredBy: "bob@example.com",
      }),
      expect.objectContaining({ skipped: true }),
    ]);
    expect(JSON.stringify(batch)).not.toMatch(/draft|bob\.work/i);
    expect(
      batch.events.filter((event: { type: string }) =>
        event.type.startsWith("answer."),
      ),
    ).toHaveLength(2);
    // Saving the edited one in the form is an ordinary answer, and drops its draft.
    await asBob("POST", `/questions/${questions[1]!.id}/answer`, {
      answer: "45",
    });
    expect(store.drafts(session.id)).toEqual({});
    await settle();
    sql.close();
  });

  it("only the assignee sends drafts", async () => {
    const { asAnn, asAgent, questions, sql } = harness();
    await asAgent("PUT", "/questions/1/draft", { answer: "Big" });
    expect(
      (
        await asAnn("POST", "/drafts/send", {
          questionIds: [questions[0]!.id],
        })
      ).statusCode,
    ).toBe(403);
    await settle();
    sql.close();
  });

  it("--send answers at once, as the assignee", async () => {
    const { asAgent, store, session, sql } = harness();
    const response = await asAgent("POST", "/questions/2/answer", {
      answer: "40",
    });
    expect(response.json()).toMatchObject({
      sent: true,
      answer: { text: "40", revision: 1 },
    });
    expect(store.getSession(session.id, "").questions[1]!.answer).toMatchObject(
      { text: "40", answeredBy: "bob@example.com" },
    );
    expect(
      (await asAgent("PUT", "/questions/2/draft", { answer: "41" })).json()
        .error,
    ).toMatch(/already answered/);
    await settle();
    sql.close();
  });

  it("start afresh for a new assignee", async () => {
    const { asAgent, store, session, sql } = harness();
    await asAgent("PUT", "/questions/1/draft", { answer: "Big" });
    store.assignSession(session.id, "carol@example.com", "Ann");
    expect(store.drafts(session.id)).toEqual({});
    await settle();
    sql.close();
  });
});

describe("chat from the assignee's agent", () => {
  it("is the assignee's message, about a question when given, delivered once", async () => {
    const { asAgent, app, session, questions, sql } = harness();
    const general = await asAgent("POST", "/chat", { text: "Thanks, Ann" });
    expect(general.json()).toMatchObject({
      message: { text: "Thanks, Ann", question: null },
    });
    const tied = await asAgent("POST", "/chat", {
      text: "Is Small wheelchair accessible?",
      question: "1",
    });
    expect(tied.json().message.question).toEqual({
      id: questions[0]!.id,
      number: 1,
    });
    const wait = () =>
      app
        .inject({
          method: "GET",
          url: `/api/sessions/${session.id}/wait?idle=0&timeout=300`,
        })
        .then((response) => response.json());
    const batch = await wait();
    expect(batch.messages).toEqual([
      expect.objectContaining({
        text: "Thanks, Ann",
        from: "bob@example.com",
        about: null,
      }),
      expect.objectContaining({
        text: "Is Small wheelchair accessible?",
        from: "bob@example.com",
        about: expect.objectContaining({
          questionId: questions[0]!.id,
          number: 1,
        }),
      }),
    ]);
    expect(JSON.stringify(batch)).not.toMatch(/agent|draft/i);
    expect((await wait()).messages).toEqual([]);
    await settle();
    sql.close();
  });
});

describe("what the assignee's agent hasn't seen", () => {
  /** The take a `kim inbox wait` makes. */
  const take = (asAgent: ReturnType<typeof harness>["asAgent"]) =>
    asAgent("POST", "/take").then((response) => response.json());

  it("is the whole interview at first, then only what's new, once", async () => {
    const { asAgent, store, session, sql } = harness();
    expect(await take(asAgent)).toMatchObject({ news: true, assigned: true });
    expect(await take(asAgent)).toMatchObject({
      news: false,
      assigned: false,
      questions: [],
      messages: [],
      artifacts: [],
    });
    const [added] = store.addQuestions(session.id, [{ prompt: "Budget?" }]);
    const reply = store.addChatMessage(session.id, "agent", {
      text: "I added a budget question.",
    });
    const news = await take(asAgent);
    expect(news).toMatchObject({
      news: true,
      questions: [{ id: added!.id, number: 4, prompt: "Budget?" }],
      messages: [{ id: reply.id, text: "I added a budget question." }],
    });
    expect((await take(asAgent)).news).toBe(false);
    await settle();
    sql.close();
  });

  it("counts reading it whole as seen", async () => {
    const { asAgent, store, session, sql } = harness();
    await asAgent("GET", "");
    expect((await take(asAgent)).news).toBe(false);
    store.addQuestions(session.id, [{ prompt: "Budget?" }]);
    expect((await take(asAgent)).questions).toHaveLength(1);
    await settle();
    sql.close();
  });

  it("brings workspace changes, one per artifact however many edits", async () => {
    const { asAgent, store, session, mockup, sql } = harness();
    await take(asAgent);
    for (const headline of ["One", "Two", "Three"])
      store.updateArtifact(session.id, mockup.id, {
        content: MOCKUP.replace("Hello", headline),
      });
    store.showArtifact(session.id, mockup.id, "agent");
    const plan = store.addArtifact(session.id, {
      kind: "plan",
      title: "Plan",
      content: "# Plan",
    });
    store.deleteArtifact(session.id, plan.id);
    // The user moving the stage is no news for anyone's agent.
    store.showArtifact(session.id, mockup.id, "user");
    const news = await take(asAgent);
    expect(news.artifacts).toEqual([
      {
        id: mockup.id,
        title: "Layout A",
        kind: "mockup",
        happened: ["revised", "shown"],
        revision: 4,
      },
      {
        id: plan.id,
        title: "Plan",
        kind: "plan",
        happened: ["removed"],
        revision: 1,
      },
    ]);
    expect((await take(asAgent)).artifacts).toEqual([]);
    await settle();
    sql.close();
  });

  it("says when a draft was written against an older artifact", async () => {
    const { asAgent, store, session, mockup, sql } = harness();
    await take(asAgent);
    await asAgent("PUT", "/questions/3/draft", { answer: "Welcome" });
    store.updateArtifact(session.id, mockup.id, { description: "Taller hero" });
    const news = await take(asAgent);
    expect(news.notes).toEqual([
      "Your draft for Q3 was written against an older Layout A (revision 1; it is now 2)",
    ]);
    expect((await asAgent("GET", "")).json().questions[2].draft).toMatchObject({
      text: "Welcome",
      artifactRevision: 1,
      stale: true,
    });
    // Rewritten against the new one, it is current again.
    await asAgent("PUT", "/questions/3/draft", { answer: "Welcome!" });
    expect((await asAgent("GET", "")).json().questions[2].draft.stale).toBe(
      false,
    );
    await settle();
    sql.close();
  });

  it("pings the assignee's agents when something arrives, not for the owner's own moves", async () => {
    const { store, session, mockup, pings, sql } = harness();
    pings.length = 0;
    store.addQuestions(session.id, [{ prompt: "Budget?" }]);
    store.addChatMessage(session.id, "agent", { text: "Added one" });
    store.updateArtifact(session.id, mockup.id, { description: "v2" });
    store.showArtifact(session.id, mockup.id, "user");
    store.focusQuestions(session.id, []);
    expect(pings).toEqual([
      { assignee: "bob@example.com", token: session.token },
      { assignee: "bob@example.com", token: session.token },
      { assignee: "bob@example.com", token: session.token },
    ]);
    // Unassigned, nobody hears.
    store.assignSession(session.id, null, null);
    store.addQuestions(session.id, [{ prompt: "Another?" }]);
    expect(pings).toHaveLength(3);
    await settle();
    sql.close();
  });
});

describe("composing an agent's answer", () => {
  const question = (overrides: Partial<QuestionView>): QuestionView => ({
    id: "q",
    type: "text",
    prompt: "?",
    recommendation: null,
    default: null,
    options: [],
    min: null,
    max: null,
    step: null,
    position: 0,
    artifactId: null,
    optionArtifacts: {},
    optionValues: {},
    control: null,
    unit: null,
    answer: null,
    ...overrides,
  });

  it("writes what the form would, in option order, with the note after", () => {
    const multiple = question({
      type: "multiple-choice",
      options: ["Red", "Green", "Blue"],
    });
    expect(
      composeParts(multiple, { options: ["blue", "Red"], note: "no green" }),
    ).toEqual({ answer: "Red, Blue — no green", skipped: false });
    expect(composeParts(multiple, { note: "None of these" })).toEqual({
      answer: "None of these",
      skipped: false,
    });
    expect(
      composeParts(question({ type: "yes-no" }), { answer: "yes" }),
    ).toEqual({ answer: "Yes", skipped: false });
    expect(composeParts(question({}), { skipped: true })).toEqual({
      answer: "",
      skipped: true,
    });
    expect(() =>
      composeParts(question({}), { skipped: true, answer: "x" }),
    ).toThrow(/A skip takes no answer/);
  });
});
