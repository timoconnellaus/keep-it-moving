/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../src/web/App.js";
import type { SessionView } from "../src/shared/schema.js";

const question = (id: string, prompt: string, position: number) => ({
  id,
  type: "text" as const,
  prompt,
  recommendation: null,
  default: null,
  options: [],
  min: null,
  max: null,
  step: null,
  position,
  artifactId: null,
  optionArtifacts: {},
  answer: null,
});

const state: SessionView = {
  id: "s1",
  title: "Sync interview",
  token: "token",
  status: "active",
  url: "http://local/s/token",
  createdAt: "",
  updatedAt: "",
  focusedQuestionId: null,
  focusedQuestionIds: [],
  questions: [
    question("11111111-1111-4111-8111-111111111111", "Which sync model?", 0),
    question("22222222-2222-4222-8222-222222222222", "Who uses it?", 1),
  ],
  artifacts: [],
  stage: null,
  stageVisible: false,
  stageVisibilitySource: null,
  project: null,
  origin: {
    branch: null,
    worktree: null,
    agent: null,
    agentSession: null,
    location: null,
  },
  chat: [
    {
      id: "m1",
      author: "user",
      text: "What does safe mean?",
      questionId: "11111111-1111-4111-8111-111111111111",
      replyTo: null,
      delivered: true,
      createdAt: "",
    },
    {
      id: "m2",
      author: "agent",
      text: "It means **no lost writes**.",
      questionId: null,
      replyTo: "m1",
      delivered: true,
      createdAt: "",
    },
  ],
  agentWatching: false,
};

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
}

let session: SessionView = state;
const posted: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  session = structuredClone(state);
  posted.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          text: string;
          questionId: string | null;
        };
        posted.push({ url: String(url), body });
        session.chat.push({
          id: `m${session.chat.length + 1}`,
          author: "user",
          text: body.text,
          questionId: body.questionId,
          replyTo: null,
          delivered: false,
          createdAt: "",
        });
        return { ok: true, json: async () => ({}) };
      }
      return String(url).endsWith("/overview")
        ? { ok: true, json: async () => ({ sessions: [] }) }
        : { ok: true, json: async () => structuredClone(session) };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("interview chat UI", () => {
  it("renders the thread with question chips and Markdown replies", async () => {
    const { container } = render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Ask the agent" }),
    );
    const chat = screen.getByRole("complementary", {
      name: "Chat with the agent",
    });
    expect(chat).toHaveTextContent("Q1 · Which sync model?");
    expect(chat).toHaveTextContent("What does safe mean?");
    expect(
      screen.getByText("no lost writes", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(chat).toHaveTextContent("Agent is away");
    expect(container.querySelector(".chat-pending")).toBeNull();
  });

  it("pre-attaches the question from Ask about this, then sends it", async () => {
    render(<App />);
    const asks = await screen.findAllByRole("button", {
      name: "Ask about this",
    });
    fireEvent.click(asks[1]!);
    const compose = screen.getByLabelText("Message to the agent");
    expect(compose.closest("form")).toHaveTextContent("Q2 · Who uses it?");
    fireEvent.change(compose, { target: { value: "Just me, or a team?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByText(
        "No agent is watching right now. It will see this when it next checks in.",
      ),
    ).toBeInTheDocument();
    expect(posted).toEqual([
      {
        url: expect.stringMatching(/^\/api\/browser\/[^/]*\/chat$/),
        body: {
          text: "Just me, or a team?",
          questionId: "22222222-2222-4222-8222-222222222222",
        },
      },
    ]);
    // The attachment is used up once sent.
    expect(compose.closest("form")).not.toHaveTextContent("Q2 · Who uses it?");
  });

  it("says the agent is waiting on it when one is watching", async () => {
    session.agentWatching = true;
    session.chat = [];
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Ask the agent" }),
    );
    fireEvent.change(screen.getByLabelText("Message to the agent"), {
      target: { value: "Skip pricing." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await screen.findByText("Waiting for the agent…"),
    ).toBeInTheDocument();
    expect(posted[0]!.body).toEqual({
      text: "Skip pricing.",
      questionId: null,
    });
  });
});
