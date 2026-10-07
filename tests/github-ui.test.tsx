/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PrListResponse, PrSummary } from "../src/shared/github.js";
import { DiffViewer } from "../src/web/features/github/Diff.js";
import { PullRequests } from "../src/web/features/github/PullRequests.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pr = (patch: Partial<PrSummary>): PrSummary => ({
  projectId: "p1",
  number: 1,
  title: "A PR",
  url: "https://github.com/o/r/pull/1",
  headRef: "feature",
  headSha: "abc",
  draft: false,
  author: "tim",
  additions: 12,
  deletions: 3,
  state: "open",
  ci: "green",
  checks: [
    { name: "test", status: "completed", conclusion: "success", url: null },
  ],
  mergeableState: "clean",
  ready: true,
  failing: [],
  updatedAt: "",
  syncedAt: "",
  ciFailedSince: null,
  readySince: null,
  ...patch,
});

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("Pull requests section", () => {
  it("lists PRs with their state, stats and CI dots, linking to the PR page", async () => {
    const list: PrListResponse = {
      repo: "o/r",
      syncedAt: new Date().toISOString(),
      error: null,
      prs: [
        pr({ number: 16, title: "Push notifications" }),
        pr({
          number: 14,
          title: "Watcher lease",
          ci: "red",
          ready: false,
          checks: [
            {
              name: "lint",
              status: "completed",
              conclusion: "success",
              url: null,
            },
            {
              name: "typecheck",
              status: "completed",
              conclusion: "failure",
              url: null,
            },
          ],
        }),
      ],
    };
    vi.stubGlobal("fetch", respond(200, list));
    render(<PullRequests projectId="p1" />);

    expect(
      await screen.findByText("#16 Push notifications"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 ready to merge")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("CI failed")).toBeInTheDocument();
    expect(screen.getByTitle("typecheck: failure")).toHaveClass(
      "kim-github-bg-red",
    );

    const popped = vi.fn();
    window.addEventListener("popstate", popped);
    fireEvent.click(screen.getByText("#14 Watcher lease"));
    expect(window.location.pathname).toBe("/p/p1/pr/14");
    expect(popped).toHaveBeenCalled();
    window.removeEventListener("popstate", popped);
  });

  it("explains the token setup when the server has none", async () => {
    vi.stubGlobal("fetch", respond(503, { error: "GITHUB_TOKEN not set" }));
    render(<PullRequests projectId="p1" />);
    expect(
      await screen.findByText("npx wrangler secret put GITHUB_TOKEN"),
    ).toBeInTheDocument();
  });
});

describe("diff viewer", () => {
  it("renders numbered hunks, a file tree, and collapses large files", () => {
    render(
      <DiffViewer
        files={[
          {
            filename: "src/a.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            previousFilename: null,
            patch: "@@ -4,2 +4,2 @@\n keep\n-old line\n+new line",
          },
          {
            filename: "src/big.ts",
            status: "added",
            additions: 900,
            deletions: 0,
            previousFilename: null,
            patch: "@@ -0,0 +1,1 @@\n+hidden until opened",
          },
        ]}
      />,
    );
    expect(screen.getByText("src/")).toBeInTheDocument();
    expect(screen.getByText("+new line").closest("tr")).toHaveClass(
      "kim-github-add",
    );
    expect(screen.getByText("-old line").closest("tr")).toHaveClass(
      "kim-github-del",
    );
    expect(screen.queryByText("+hidden until opened")).toBeNull();
    fireEvent.click(screen.getByText("big.ts"));
    expect(screen.getByText("+hidden until opened")).toBeInTheDocument();
  });
});
