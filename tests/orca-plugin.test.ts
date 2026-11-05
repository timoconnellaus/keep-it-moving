import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  focusedWorkspace,
  interviewsIn,
  NOTHING_SEEN,
  notifications,
  statusItem,
  WAITING_MS,
} from "../orca-plugin/src/attention.js";
import { problemFrom } from "../orca-plugin/src/kim.js";
import { prepareMockup, type Kit } from "../orca-plugin/src/mockup.js";
import type { OwnInterview, Overview } from "../orca-plugin/src/protocol.js";
import {
  parseLiteral,
  themeFromPage,
} from "../orca-plugin/src/tailwindConfig.js";

const own = (overrides: Partial<OwnInterview> = {}): OwnInterview => ({
  id: "s1",
  token: "t1",
  title: "CRM data model",
  status: "active",
  url: "https://kim.test/s/t1",
  project: null,
  origin: {
    branch: "crm",
    worktree: "crm-person-model",
    agent: "Claude Code",
    agentSession: null,
    location: "local",
  },
  answered: 2,
  total: 9,
  open: 7,
  assignee: null,
  lastActivity: "2026-11-05T00:00:00.000Z",
  lastReply: null,
  awaitingReply: false,
  agentWatching: false,
  ...overrides,
});
const overview = (overrides: Partial<Overview> = {}): Overview => ({
  sessions: [own()],
  inbox: [],
  ...overrides,
});

describe("the status bar item", () => {
  it("shows only when something needs the user, naming one or counting several", () => {
    expect(statusItem(overview({ sessions: [own({ open: 0 })] })).visible).toBe(
      false,
    );
    expect(
      statusItem(overview({ sessions: [own({ assignee: "jo@x.dev" })] }))
        .visible,
    ).toBe(false);
    expect(statusItem(overview()).text).toBe("CRM data model needs you");
    const sent = {
      id: "t2",
      url: "",
      title: "Pricing copy",
      from: "Jo",
      sentTo: "me",
      status: "active" as const,
      openQuestions: 3,
      drafted: 0,
    };
    const both = statusItem(overview({ inbox: [sent] }));
    expect(both.text).toBe("2 interviews need you");
    expect(both.tooltip).toContain("Pricing copy");
  });
});

describe("notifications", () => {
  const now = Date.parse("2026-11-05T00:20:00.000Z");
  it("only records on the first look, then notifies about replies once", () => {
    const replied = overview({
      sessions: [
        own({
          lastReply: {
            text: "Done: **added** it.\\n\\nNext?",
            at: "2026-11-05T00:01:00Z",
          },
        }),
      ],
    });
    const first = notifications(replied, NOTHING_SEEN, now, true);
    expect(first.notes).toEqual([]);
    expect(notifications(replied, first.seen, now, false).notes).toEqual([]);
    const again = overview({
      sessions: [
        own({ lastReply: { text: "Another", at: "2026-11-05T00:02:00Z" } }),
      ],
    });
    expect(notifications(again, first.seen, now, false).notes).toEqual([
      { title: "CRM data model · reply", body: "Another" },
    ]);
    expect(
      notifications(replied, NOTHING_SEEN, now, false).notes[0]!.body,
    ).toBe("Done: added it. Next?");
  });

  it("nudges once when an agent has waited 10 minutes on open questions", () => {
    const waiting = overview({
      sessions: [
        own({
          agentWatching: true,
          lastActivity: new Date(now - WAITING_MS - 1).toISOString(),
        }),
      ],
    });
    const first = notifications(waiting, NOTHING_SEEN, now, false);
    expect(first.notes).toEqual([
      expect.objectContaining({ title: "CRM data model is waiting on you" }),
    ]);
    expect(
      notifications(waiting, first.seen, now + 60_000, false).notes,
    ).toEqual([]);
    const fresh = overview({
      sessions: [
        own({
          agentWatching: true,
          lastActivity: new Date(now - 60_000).toISOString(),
        }),
      ],
    });
    expect(notifications(fresh, NOTHING_SEEN, now, false).notes).toEqual([]);
  });

  it("tells the user about an interview sent to them", () => {
    const sent = {
      id: "t2",
      url: "",
      title: "Pricing copy",
      from: "Jo",
      sentTo: "me",
      status: "active" as const,
      openQuestions: 1,
      drafted: 0,
    };
    const result = notifications(
      overview({ sessions: [], inbox: [sent] }),
      NOTHING_SEEN,
      now,
      false,
    );
    expect(result.notes).toEqual([
      { title: "Sent to you: Pricing copy", body: "Jo sent you 1 question." },
    ]);
    expect(
      notifications(
        overview({ sessions: [], inbox: [sent] }),
        result.seen,
        now,
        false,
      ).notes,
    ).toEqual([]);
  });
});

describe("matching interviews to Orca workspaces", () => {
  const workspaces = [
    {
      id: "w1",
      kind: "worktree" as const,
      name: "crm-person-model",
      path: "/r/crm-person-model",
      branch: "crm",
    },
    {
      id: "w2",
      kind: "worktree" as const,
      name: "interviewer",
      path: "/r/interviewer",
      branch: "main",
    },
  ];
  it("finds the focused workspace and the interviews started in it", () => {
    const focused = focusedWorkspace(workspaces, {
      branch: "crm",
      displayName: "crm-person-model",
    });
    expect(focused?.id).toBe("w1");
    const other = own({
      id: "s2",
      origin: { ...own().origin, worktree: "interviewer", branch: "main" },
    });
    const older = own({ id: "s3", lastActivity: "2026-11-04T00:00:00.000Z" });
    expect(
      interviewsIn(overview({ sessions: [older, other, own()] }), focused).map(
        (item) => item.id,
      ),
    ).toEqual(["s1", "s3"]);
    // Same folder, another branch: not this workspace's.
    const moved = own({ origin: { ...own().origin, branch: "other" } });
    expect(interviewsIn(overview({ sessions: [moved] }), focused)).toEqual([]);
    expect(focusedWorkspace(workspaces, null)).toBeNull();
  });
});

describe("what kim's failures mean", () => {
  it("tells a missing kim and a signed-out one from an error", () => {
    expect(problemFrom(127, "", "zsh:1: command not found: kim")).toEqual({
      kind: "missing",
    });
    expect(
      problemFrom(1, "", "Not signed in. Run `kim login` in a terminal."),
    ).toEqual({ kind: "signed-out" });
    expect(problemFrom(1, '{"error":"Session not found"}', "")).toEqual({
      kind: "failed",
      message: "Session not found",
    });
  });
});

describe("an inline Tailwind config, read as data", () => {
  it("turns colours, fonts, radii and shadows into theme variables", () => {
    const page = `<script src="https://cdn.tailwindcss.com"></script><script>
      tailwind.config = {
        // brand colours
        theme: { extend: {
          colors: { brand: { DEFAULT: '#ff3366', 600: "#cc2952" }, ink: '#111' },
          fontFamily: { display: ['Fraunces', 'serif'], body: "Inter Tight" },
          borderRadius: { xl2: '1.25rem' },
        } },
      };
    </script>`;
    const theme = themeFromPage(page);
    expect(theme.startsWith("@theme {")).toBe(true);
    for (const line of [
      "--color-brand: #ff3366;",
      "--color-brand-600: #cc2952;",
      "--color-ink: #111;",
      "--font-display: Fraunces, serif;",
      '--font-body: "Inter Tight";',
      "--radius-xl2: 1.25rem;",
    ])
      expect(theme).toContain(line);
  });

  it("never runs anything: code isn't data", () => {
    expect(parseLiteral("{ a: fetch('x') }")).toBeNull();
    expect(parseLiteral("{ ...other }")).toBeNull();
    expect(parseLiteral("{ a: `x${y}` }")).toBeNull();
    expect(
      themeFromPage(
        "<script>tailwind.config = { theme: (() => ({}))() }</script>",
      ),
    ).toBe("");
    expect(parseLiteral("{ a: [1, 'two', true, null,], }")).toEqual({
      a: [1, "two", true, null],
    });
  });
});

describe("preparing a mockup with the kit", () => {
  const kit = async (): Promise<Kit> => ({
    compileTailwind: (await import("../orca-plugin/vendor/tailwind.mjs"))
      .compileTailwind,
    lucide: JSON.parse(
      readFileSync(
        new URL("../orca-plugin/vendor/lucide.json", import.meta.url),
        "utf8",
      ),
    ),
  });

  it("compiles the Tailwind a page uses, with its theme, and draws Lucide icons", async () => {
    const page = `<!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config = { theme: { extend: { colors: { brand: '#ff3366' } } } }</script></head>
<body class="bg-slate-50"><div class="p-4 md:flex text-brand"><i data-lucide="mail" class="w-4 h-4"></i>Hi</div>
<script src="https://unpkg.com/lucide@latest"></script><script>lucide.createIcons();</script></body></html>`;
    const prepared = await prepareMockup(page, await kit());
    expect(prepared.css).toContain(".bg-slate-50");
    expect(prepared.css).toContain(".text-brand");
    expect(prepared.css).toContain("--color-brand: #ff3366");
    expect(prepared.html).toContain('class="lucide lucide-mail w-4 h-4"');
    expect(prepared.html).not.toContain("data-lucide");
    // Tailwind and Lucide's own scripts aren't a loss; nothing else ran.
    expect(prepared.limits).toEqual([]);
  });

  it("says when a page needs scripts the panel won't run, and leaves plain CSS alone", async () => {
    const prepared = await prepareMockup(
      `<style>body{margin:0}</style><div id="chart"></div><script>new Chart(document.getElementById("chart"))</script>`,
      await kit(),
    );
    expect(prepared.css).toBe("");
    expect(prepared.limits).toEqual(["scripts"]);
  });
});
