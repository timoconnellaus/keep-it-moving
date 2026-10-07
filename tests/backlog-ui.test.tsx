/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { InboxItem } from "../src/shared/inbox.js";
import type { ProjectBacklogView } from "../src/shared/backlog.js";
import { FollowUpsDetail } from "../src/web/features/backlog/FollowUps.js";
import { MilestoneSection } from "../src/web/features/backlog/Milestone.js";
import { UpNextSection } from "../src/web/features/backlog/UpNext.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const view: ProjectBacklogView = {
  project: { id: "p1", key: "github.com/tim/interviewer", name: "Interviewer" },
  settings: {
    source: "script",
    configured: true,
    hasScript: true,
    autoWrite: false,
    milestoneOverride: null,
    syncedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    syncError: null,
  },
  milestone: {
    sourceId: "2",
    name: "M2 · Hosted workbench",
    due: "2026-10-24",
    url: null,
    manual: false,
    done: 5,
    inProgress: 3,
    total: 11,
  },
  upNext: [
    {
      sourceId: "7",
      title: "Project model + sync scripts",
      status: "in_progress",
      url: "https://github.com/tim/interviewer/issues/7",
      milestone: "2",
      priority: null,
      order: 0,
      assignee: "tim",
      labels: [],
      body: null,
      origin: "source",
      updatedAt: "",
    },
  ],
  counts: { todo: 5, inProgress: 3, done: 5, total: 13 },
  syncCommand: "interviewer backlog sync --project github.com/tim/interviewer",
};

describe("backlog sections", () => {
  it("shows the milestone with its progress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(view)),
    );
    render(<MilestoneSection projectId="p1" />);
    expect(
      await screen.findByText("M2 · Hosted workbench"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Milestone · due 24 Oct · 5 of 11 done · 3 in progress"),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "5",
    );
  });

  it("lists up next and shows the CLI command when a script source syncs", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/sync")
        ? json({ error: "Run the command.", command: view.syncCommand }, 409)
        : json(view),
    );
    vi.stubGlobal("fetch", fetch);
    render(<UpNextSection projectId="p1" />);
    expect(await screen.findByText("#7")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Project model + sync scripts" }),
    ).toHaveAttribute("href", "https://github.com/tim/interviewer/issues/7");
    expect(screen.getByText("In progress")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText(view.syncCommand)).toBeInTheDocument();
  });
});

describe("follow-ups in the inbox", () => {
  it("triages each row and calls done when none are left", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { action: string };
        calls.push({ url, body });
        return json({
          followUp: { id: url.split("/").pop(), state: "x" },
          ...(body.action === "start" ? { command: 'claude "Two"' } : {}),
        });
      }),
    );
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const done = vi.fn();
    const item: InboxItem = {
      id: "follow_ups:p1",
      kind: "follow_ups",
      projectId: "p1",
      title: "2 follow-ups",
      brief: "",
      source: "",
      since: "",
      data: {
        projectId: "p1",
        followUps: [
          { id: "f1", text: "One", agentSessionId: null },
          { id: "f2", text: "Two", agentSessionId: null },
        ],
      },
    };
    render(<FollowUpsDetail item={item} done={done} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss follow-up: One" }),
    );
    await waitFor(() => expect(screen.queryByText("One")).toBeNull());
    expect(done).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('claude "Two"');
    await waitFor(() => expect(done).toHaveBeenCalledOnce(), {
      timeout: 3000,
    });
    expect(calls.map((call) => call.body)).toEqual([
      { action: "dismiss" },
      { action: "start" },
    ]);
  });
});
