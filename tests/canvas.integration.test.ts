import { describe, expect, it } from "vitest";
import { hubHarness } from "./helpers/harness.js";

/** An interview with a plan and a mockup, and a page that hears every state broadcast. */
async function interview() {
  const broadcasts: string[] = [];
  const { app, store } = hubHarness({
    sockets: {
      send: (_id: string, data: string) => void broadcasts.push(data),
      sendAll: () => undefined,
    },
  });
  const session = (
    await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Checkout rework" },
    })
  ).json();
  const artifact = async (payload: Record<string, unknown>) =>
    (
      await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/artifacts`,
        payload,
      })
    ).json();
  const plan = await artifact({
    kind: "plan",
    title: "Plan",
    content: "# Plan",
  });
  const mockup = await artifact({
    kind: "mockup",
    title: "Layout A",
    content: "<!doctype html><html><body><button>Pay</button></body></html>",
  });
  const browser = async () =>
    (
      await app.inject({
        method: "GET",
        url: `/api/browser/${session.token}/session`,
      })
    ).json();
  const move = (artifactId: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/browser/${session.token}/frames/${artifactId}/position`,
      payload,
    });
  const ask = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/browser/${session.token}/chat`,
      payload,
    });
  const wait = async () =>
    (
      await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/wait?idle=0&timeout=2000`,
      })
    ).json();
  return {
    app,
    store,
    session,
    plan,
    mockup,
    browser,
    move,
    ask,
    wait,
    broadcasts,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("frame positions", () => {
  it("keeps where the user put a frame, for every viewer, without telling the agent", async () => {
    const { mockup, plan, browser, move, broadcasts, store, session } =
      await interview();
    expect((await browser()).positions).toEqual({});
    await settle();
    broadcasts.length = 0;
    const queued = store.undeliveredEvents(session.id).length;

    expect((await move(mockup.id, { x: 1400.4, y: -220 })).statusCode).toBe(
      200,
    );
    await move(mockup.id, { x: 1500, y: -200 });
    await move(plan.id, { x: 0, y: 900 });
    expect((await browser()).positions).toEqual({
      [mockup.id]: { x: 1500, y: -200 },
      [plan.id]: { x: 0, y: 900 },
    });
    // Other viewers hear of it; the agent's queue doesn't.
    await settle();
    expect(broadcasts.length).toBeGreaterThan(0);
    expect(store.undeliveredEvents(session.id)).toHaveLength(queued);
  });

  it("forgets a deleted artifact's frame, and refuses nonsense", async () => {
    const { app, session, mockup, browser, move } = await interview();
    await move(mockup.id, { x: 10, y: 10 });
    expect((await move(mockup.id, { x: "far" })).statusCode).toBe(400);
    expect((await move(crypto.randomUUID(), { x: 1, y: 1 })).statusCode).toBe(
      404,
    );
    await app.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}/artifacts/${mockup.id}`,
    });
    expect((await browser()).positions).toEqual({});
  });

  it("can still be arranged once the interview stops", async () => {
    const { app, session, mockup, move } = await interview();
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/stop`,
    });
    expect((await move(mockup.id, { x: 5, y: 5 })).statusCode).toBe(200);
  });
});

describe("comment pins", () => {
  const pin = (artifactId: string, element = "pay button") => ({
    artifactId,
    element,
    selector: null,
    x: 412.6,
    y: 980.2,
    fx: 0.5,
    fy: 0.25,
    width: 1280,
  });

  it("numbers pins in order and shows them to every viewer", async () => {
    const { mockup, plan, ask, browser } = await interview();
    await ask({ text: "Make this bigger", pin: pin(mockup.id) });
    await ask({ text: "No pin here" });
    await ask({ text: "Reword", pin: pin(plan.id, 'h1 "Plan"') });
    const chat = (await browser()).chat;
    expect(chat.map((message: { pin: unknown }) => message.pin)).toEqual([
      { n: 1, ...pin(mockup.id) },
      null,
      { n: 2, ...pin(plan.id, 'h1 "Plan"') },
    ]);
  });

  it("hands the agent the artifact, element and position with the message", async () => {
    const { mockup, ask, wait } = await interview();
    const sent = (
      await ask({
        text: "Make this bigger",
        pin: {
          ...pin(mockup.id, 'button "Pay"'),
          selector: "body > main:nth-of-type(1) > button:nth-of-type(1)",
        },
      })
    ).json();
    const batch = await wait();
    expect(batch.messages).toEqual([
      {
        messageId: sent.id,
        text: "Make this bigger",
        about: null,
        pin: {
          n: 1,
          artifactId: mockup.id,
          artifact: "Layout A",
          element: 'button "Pay"',
          selector: "body > main:nth-of-type(1) > button:nth-of-type(1)",
          x: 413,
          y: 980,
          width: 1280,
        },
      },
    ]);
    expect(
      batch.events.find(
        (event: { type: string }) => event.type === "chat.message",
      ).payload.pin,
    ).toMatchObject({ n: 1, artifactId: mockup.id });
  });

  it("refuses a pin on an artifact that isn't in the interview, or out of range", async () => {
    const { mockup, ask } = await interview();
    expect(
      (await ask({ text: "Here", pin: pin(crypto.randomUUID()) })).statusCode,
    ).toBe(400);
    expect(
      (await ask({ text: "Here", pin: { ...pin(mockup.id), fx: 3 } }))
        .statusCode,
    ).toBe(400);
  });

  it("never pins the agent's own replies", async () => {
    const { app, session, mockup, browser } = await interview();
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { text: "Done", pin: pin(mockup.id) },
    });
    expect((await browser()).chat[0].pin).toBeNull();
  });
});
