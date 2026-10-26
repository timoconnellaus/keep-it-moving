/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "../src/shared/inbox.js";
import { Shell } from "../src/web/features/shell/Shell.js";

const project = {
  id: "p1",
  key: "github.com/o/frockbot",
  name: "FrockBot",
  color: "#7a2e8f",
  stats: { needsYou: 2, running: 3 },
};
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
const items: InboxItem[] = [
  {
    id: "needs_you:a@1",
    kind: "needs_you",
    projectId: "p1",
    title: "Intake form",
    brief: "Claude needs your permission to use Bash",
    source: 'session "Intake form" · local · tim-mbp',
    since: minutesAgo(30),
    data: { status: "needs_you", branch: "claude/intake", machine: "tim-mbp" },
  },
  {
    id: "needs_you:b@1",
    kind: "needs_you",
    projectId: "p1",
    title: "Booking refactor",
    brief: "Finished and opened a PR.",
    source: 'session "Booking refactor"',
    since: minutesAgo(5),
    later: true,
    data: { status: "idle" },
  },
];

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
}

beforeEach(() => {
  localStorage.clear();
  history.pushState(null, "", "/");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.endsWith("/kim/projects")
        ? { projects: [project] }
        : url.endsWith("/kim/inbox")
          ? { items }
          : url.endsWith("/browser/me")
            ? { email: "ann@example.com", name: "Ann" }
            : url.includes("/sessions")
              ? { sessions: [] }
              : { sessions: [] };
      return { ok: true, json: async () => structuredClone(body) };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Keep it moving shell", () => {
  it("lists the inbox oldest first with the first item's detail, and Done moves on", async () => {
    render(<Shell />);
    const list = await screen.findByRole("region", { name: "Inbox" });
    expect(list).toHaveTextContent("Intake form");
    expect(screen.getByText("2 left")).toBeInTheDocument();
    expect(screen.getByText("Waiting", { exact: false })).toBeInTheDocument();
    const detail = screen.getByRole("region", { name: "Selected item" });
    expect(detail).toHaveTextContent("Claude needs your permission");
    expect(detail).toHaveTextContent("claude/intake");

    fireEvent.click(screen.getByRole("button", { name: "Done → next" }));
    expect(
      screen.getByRole("region", { name: "Selected item" }),
    ).toHaveTextContent("Booking refactor");
    expect(screen.getByText("1 left")).toBeInTheDocument();
    expect(localStorage.getItem("kim-inbox-hidden")).toContain("needs_you:a@1");
  });

  it("shows who is signed in, with Sign out behind the avatar", async () => {
    render(<Shell />);
    const avatar = await screen.findByRole("button", {
      name: "Signed in as ann@example.com",
    });
    fireEvent.click(avatar);
    expect(screen.getByRole("menu")).toHaveTextContent("ann@example.com");
    expect(
      screen.getByRole("menuitem", { name: "Sign out" }).closest("form"),
    ).toHaveAttribute("action", "/auth/logout");
  });

  it("shows projects in the rail and opens a project page in place", async () => {
    render(<Shell />);
    const rail = await screen.findByRole("navigation", { name: "Projects" });
    const link = await screen.findByRole("link", { name: /FrockBot/ });
    expect(rail).toHaveTextContent("3");
    fireEvent.click(link);
    expect(location.pathname).toBe("/p/p1");
    expect(
      await screen.findByRole("heading", { name: "FrockBot" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Sessions" }),
    ).toHaveTextContent("0 active");
  });
});
