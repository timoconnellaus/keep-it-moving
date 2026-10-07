/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { InboxItem } from "../src/shared/inbox.js";
import { AutomationDown } from "../src/web/features/automations/AutomationDown.js";
import { AutomationsSection } from "../src/web/features/automations/AutomationsSection.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function item(machineAlive: boolean | null): InboxItem {
  return {
    id: "automation_down:a1",
    kind: "automation_down",
    projectId: "p1",
    title: "babysitter missed 4 check-ins",
    brief: "",
    source: "",
    since: ago(12),
    data: {
      automationId: "a1",
      every: 300,
      lastBeat: ago(22),
      machine: "tim-mbp",
      machineLastSeen: machineAlive ? ago(1) : ago(40),
      machineAlive,
      command: "/loop /babysitter",
      lastStatus: "merged #15; 2 queued",
    },
  };
}

describe("automation down detail", () => {
  it("shows the tiles and says to restart the loop when the machine is alive", () => {
    render(<AutomationDown item={item(true)} done={() => undefined} />);
    expect(screen.getByText("every 5m")).toBeInTheDocument();
    expect(screen.getByText("22m ago")).toBeInTheDocument();
    expect(screen.getByText("tim-mbp · alive")).toBeInTheDocument();
    expect(screen.getByText("merged #15; 2 queued")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The loop stopped, but the machine is alive: restart /loop /babysitter on tim-mbp.",
      ),
    ).toBeInTheDocument();
  });

  it("says when the machine is offline", () => {
    render(<AutomationDown item={item(false)} done={() => undefined} />);
    expect(screen.getByText("tim-mbp · offline")).toBeInTheDocument();
    expect(screen.getByText(/tim-mbp is offline/)).toBeInTheDocument();
  });
});

describe("automations section", () => {
  it("lists each automation with its heartbeat, then its machines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          automations: [
            {
              id: "a1",
              projectId: "p1",
              name: "Babysitter",
              every: 300,
              command: "/loop /babysitter",
              machine: "tim-mbp",
              lastBeat: ago(2),
              lastStatus: "2 queued",
              registeredAt: ago(60),
              downSince: null,
              machineLastSeen: ago(0.5),
              machineAlive: true,
            },
            {
              id: "a2",
              projectId: "p1",
              name: "Nightly deps",
              every: 86_400,
              command: null,
              machine: "tim-mbp",
              lastBeat: ago(3000),
              lastStatus: null,
              registeredAt: ago(9000),
              downSince: ago(22),
              machineLastSeen: ago(0.5),
              machineAlive: true,
            },
          ],
          machines: [
            {
              name: "tim-mbp",
              platform: "darwin",
              lastSeen: ago(0.5),
              alive: true,
            },
          ],
        }),
      ),
    );
    render(<AutomationsSection projectId="p1" />);
    expect(await screen.findByText("Babysitter")).toBeInTheDocument();
    expect(screen.getByText("2m ago")).toBeInTheDocument();
    expect(screen.getByText("2 queued")).toBeInTheDocument();
    expect(screen.getByText("down 22m")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Down" })).toBeInTheDocument();
    // Only a down automation offers removal.
    expect(
      screen.getByRole("button", { name: "Remove Nightly deps" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Babysitter" })).toBe(
      null,
    );
    expect(screen.getByText("tim-mbp")).toBeInTheDocument();
    expect(screen.getByText("30s ago")).toBeInTheDocument();
  });
});
