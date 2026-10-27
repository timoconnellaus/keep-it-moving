/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../src/shared/schema.js";
import { Home } from "../src/web/Home.js";
import { homeOrder, waitingOn } from "../src/web/overview.js";

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const summary = (overrides: Partial<SessionSummary>): SessionSummary => ({
  id: "s1",
  token: "token-s1",
  title: "Interview",
  status: "active",
  project: null,
  origin: {
    branch: null,
    worktree: null,
    agent: null,
    agentSession: null,
    location: null,
  },
  answered: 0,
  total: 0,
  open: 0,
  assignee: null,
  lastActivity: minutesAgo(1),
  lastReply: null,
  awaitingReply: false,
  ...overrides,
});

describe("who an interview waits on", () => {
  it("waits on you for open questions, and on nobody once stopped", () => {
    expect(waitingOn(summary({ open: 2, total: 3, answered: 1 }))).toEqual({
      who: "you",
      label: "Waiting on you",
    });
    expect(
      waitingOn(summary({ status: "stopped", open: 0, total: 3 })),
    ).toBeNull();
  });

  it("waits on the assignee while their questions are open", () => {
    expect(
      waitingOn(
        summary({ assignee: "bob@example.com", total: 3, answered: 1 }),
      ),
    ).toEqual({ who: "assignee", label: "Waiting on bob@example.com" });
  });

  it("waits on the agent with nothing open, or a chat message it hasn't answered", () => {
    expect(waitingOn(summary({ total: 2, answered: 2 }))?.who).toBe("agent");
    // A message from you outranks your own open questions: you asked first.
    expect(
      waitingOn(summary({ open: 1, total: 1, awaitingReply: true })),
    ).toEqual({ who: "agent", label: "Waiting on the agent" });
  });
});

describe("the home list's order", () => {
  it("puts what waits on you first, then other active, then stopped, newest first in each", () => {
    const sessions = [
      summary({
        id: "stopped-new",
        status: "stopped",
        lastActivity: minutesAgo(1),
      }),
      summary({
        id: "agent-old",
        total: 1,
        answered: 1,
        lastActivity: minutesAgo(50),
      }),
      summary({
        id: "you-old",
        open: 1,
        total: 1,
        lastActivity: minutesAgo(40),
      }),
      summary({
        id: "agent-new",
        awaitingReply: true,
        lastActivity: minutesAgo(2),
      }),
      summary({
        id: "you-new",
        open: 3,
        total: 3,
        lastActivity: minutesAgo(5),
      }),
      summary({
        id: "stopped-old",
        status: "stopped",
        lastActivity: minutesAgo(90),
      }),
    ];
    expect(homeOrder(sessions).map((session) => session.id)).toEqual([
      "you-new",
      "you-old",
      "agent-new",
      "agent-old",
      "stopped-new",
      "stopped-old",
    ]);
  });
});

let overview: SessionSummary[] = [];
let shared: Array<{ token: string; title: string; from: string }> = [];

class FakeSocket {
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  overview = [];
  shared = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith("/overview")
          ? { sessions: structuredClone(overview) }
          : url.endsWith("/shared")
            ? { interviews: structuredClone(shared) }
            : { email: "tim@example.com", name: "Tim" },
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("home page", () => {
  it("lists every interview with what's left and who it waits on, waiting on you first", async () => {
    overview = [
      summary({
        id: "a",
        token: "token-a",
        title: "Data import",
        status: "stopped",
        total: 2,
        answered: 2,
      }),
      summary({
        id: "b",
        token: "token-b",
        title: "Venue survey",
        assignee: "bob@example.com",
        total: 4,
        answered: 1,
        lastActivity: minutesAgo(3),
      }),
      summary({
        id: "c",
        token: "token-c",
        title: "Checkout flow",
        project: {
          id: "p1",
          key: "github.com/o/shop",
          name: "Shop",
          color: "#0f6b62",
        },
        total: 3,
        answered: 1,
        open: 2,
        lastActivity: minutesAgo(30),
      }),
    ];
    render(<Home />);
    const list = await screen.findByRole("region", { name: "Your interviews" });
    const rows = within(list).getAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      "/s/token-c",
      "/s/token-b",
      "/s/token-a",
    ]);
    expect(rows[0]).toHaveTextContent("Checkout flow");
    expect(rows[0]).toHaveTextContent("Shop");
    expect(rows[0]).toHaveTextContent("1 of 3 answered");
    expect(rows[0]).toHaveTextContent("Waiting on you");
    expect(rows[1]).toHaveTextContent("Assigned to bob@example.com");
    expect(rows[1]).toHaveTextContent("Waiting on bob@example.com");
    expect(rows[2]).toHaveTextContent("2 of 2 answered");
    expect(rows[2]).toHaveTextContent("Stopped");
    expect(
      screen.getByText(/1 waiting on you · 2 active · 1 stopped/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Signed in as tim@example.com" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Shared with you" }),
    ).toBeNull();
  });

  it("shows interviews others assigned to you, with who they're from", async () => {
    overview = [summary({ title: "Mine" })];
    shared = [{ token: "theirs", title: "Client intake", from: "Ann" }];
    render(<Home />);
    const section = await screen.findByRole("region", {
      name: "Shared with you",
    });
    const row = within(section).getByRole("link");
    expect(row).toHaveAttribute("href", "/s/theirs");
    expect(row).toHaveTextContent("Client intake");
    expect(row).toHaveTextContent("From Ann");
    expect(
      await screen.findByRole("region", { name: "Your interviews" }),
    ).toHaveTextContent("Mine");
  });

  it("says how interviews start when there are none", async () => {
    render(<Home />);
    expect(await screen.findByText("No interviews yet")).toBeInTheDocument();
  });
});

describe("the Claude Code setup box", () => {
  const commands = [
    `npm install -g ${location.origin}/cli.tgz`,
    "kim skill install",
    "kim login",
  ].join("\n");

  it("shows the install commands for this site, and copies them", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<Home />);
    const box = screen.getByRole("region", { name: "Use it with Claude Code" });
    expect(box.querySelector("pre")?.textContent).toBe(commands);
    expect(box).toHaveTextContent("interview me about this feature");
    await act(async () => {
      fireEvent.click(within(box).getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith(commands);
    expect(within(box).getByRole("button", { name: "Copied" })).toBeVisible();
  });

  it("stays dismissed once dismissed", () => {
    const { unmount } = render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByRole("region", { name: "Use it with Claude Code" }),
    ).toBeNull();
    unmount();
    render(<Home />);
    expect(
      screen.queryByRole("region", { name: "Use it with Claude Code" }),
    ).toBeNull();
  });

  it("still shows and dismisses when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      render(<Home />);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(
        screen.queryByRole("region", { name: "Use it with Claude Code" }),
      ).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
