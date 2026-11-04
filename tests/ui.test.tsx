/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import { App } from "../src/web/App.js";
import type { SessionSummary, SessionView } from "../src/shared/schema.js";

const state: SessionView = {
  id: "s1",
  title: "Todo list product interview",
  token: "token",
  status: "active",
  url: "http://local/s/token",
  createdAt: "",
  updatedAt: "",
  focusedQuestionId: null,
  focusedQuestionIds: [],
  questions: [
    {
      id: "q1",
      type: "single-choice",
      prompt: "Choose a direction",
      recommendation: "Pick **A**. <script>alert(1)</script>",
      default: null,
      options: ["A", "B"],
      min: null,
      max: null,
      step: null,
      position: 0,
      artifactId: null,
      optionArtifacts: {},
      optionValues: {},
      control: null,
      unit: null,
      answer: {
        text: "A",
        skipped: false,
        revision: 1,
        delivered: true,
        updatedAt: "",
        answeredBy: null,
      },
    },
  ],
  artifacts: [],
  stage: null,
  stageVisible: false,
  stageVisibilitySource: null,
  positions: {},
  project: {
    id: "p1",
    key: "github.com/o/interviewer",
    name: "Interviewer",
    color: "#0f6b62",
  },
  origin: {
    branch: "claude/switcher",
    worktree: "interviewer-switcher",
    agent: "Claude Code",
    agentSession: "Switcher",
    location: "local",
  },
  chat: [],
  assignee: null,
  assignedBy: null,
};

const summary = (overrides: Partial<SessionSummary>): SessionSummary => ({
  id: "s1",
  token: "token",
  title: "Todo list product interview",
  status: "active",
  project: state.project,
  origin: state.origin,
  answered: 1,
  total: 1,
  open: 0,
  lastActivity: new Date().toISOString(),
  lastReply: null,
  awaitingReply: false,
  assignee: null,
  ...overrides,
});
let overview: SessionSummary[] = [summary({})];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code: number }) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED;
  });
  constructor() {
    FakeSocket.instances.push(this);
  }
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  overview = [summary({})];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).endsWith("/overview")
        ? {
            ok: true,
            json: async () => ({ sessions: structuredClone(overview) }),
          }
        : { ok: true, json: async () => structuredClone(state) },
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  FakeSocket.instances.length = 0;
});

describe("assigning an interview", () => {
  it("shows the assignee the interview and who it's from, not the owner's list", async () => {
    const respondent: SessionView = {
      ...state,
      project: null,
      assignee: "bob@example.com",
      assignedBy: "Ann",
      respondent: true,
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => structuredClone(respondent),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(await screen.findByText("From Ann")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Switch interview|Assign/ }),
    ).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/overview")),
    ).toBe(false);
  });

  it("lets the owner assign it and shows who answered", async () => {
    const assigned: SessionView = {
      ...state,
      assignee: "bob@example.com",
      questions: [
        {
          ...state.questions[0]!,
          answer: {
            ...state.questions[0]!.answer!,
            answeredBy: "bob@example.com",
          },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/overview")
          ? { ok: true, json: async () => ({ sessions: [] }) }
          : { ok: true, json: async () => structuredClone(assigned) },
      ),
    );
    render(<App />);
    expect(await screen.findByText("by bob@example.com")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Assigned to bob@example.com" }),
    );
    expect(
      screen.getByRole("button", { name: "Stop sharing" }),
    ).toBeInTheDocument();
  });
});

describe("drafts from the assignee's agent", () => {
  const open = (id: string, prompt: string) => ({
    ...state.questions[0]!,
    id,
    prompt,
    answer: null,
  });
  const drafted: SessionView = {
    ...state,
    project: null,
    assignee: "bob@example.com",
    assignedBy: "Ann",
    respondent: true,
    questions: [
      open("q1", "Choose a direction"),
      { ...open("q2", "Why?"), type: "text", options: [] },
      open("q3", "Budget?"),
    ],
    drafts: {
      q1: {
        text: "B — the bolder one",
        skipped: false,
        draftedBy: "bob@example.com",
        updatedAt: "",
        artifactRevision: null,
      },
      q2: {
        text: "Matches the brand",
        skipped: false,
        draftedBy: "bob@example.com",
        updatedAt: "",
        artifactRevision: null,
      },
    },
  };

  it("prefills each drafted question, says so, and sends the untouched ones", async () => {
    const fetchMock = vi.fn(async (...request: [string, RequestInit?]) => ({
      ok: true,
      json: async () => structuredClone(drafted),
      request,
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "Send 2 drafts" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Drafted by your agent")).toHaveLength(2);
    const first = screen
      .getByText("Choose a direction")
      .closest("article") as HTMLElement;
    expect(within(first).getByRole("button", { name: /^B/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(first).getByLabelText("Other answer or note")).toHaveValue(
      "the bolder one",
    );
    // Editing one keeps it out of the batch, and it says it was edited.
    const second = screen.getByText("Why?").closest("article") as HTMLElement;
    fireEvent.change(within(second).getByLabelText("Your answer"), {
      target: { value: "Matches the brand, mostly" },
    });
    expect(
      within(second).getByText("Edited from your agent's draft"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send 1 draft" }));
    await act(async () => undefined);
    const send = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/drafts/send"),
    );
    expect(JSON.parse(String(send![1]!.body))).toEqual({ questionIds: ["q1"] });
  });

  it("fills in a draft that arrives while the page is open", async () => {
    const before = { ...drafted, drafts: {} };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => structuredClone(before),
      })),
    );
    render(<App />);
    const card = (await screen.findByText("Why?")).closest(
      "article",
    ) as HTMLElement;
    expect(within(card).getByLabelText("Your answer")).toHaveValue("");
    act(() =>
      FakeSocket.instances[0]!.onmessage?.({
        data: JSON.stringify({ type: "state", session: drafted }),
      } as MessageEvent),
    );
    expect(within(card).getByLabelText("Your answer")).toHaveValue(
      "Matches the brand",
    );
    expect(within(card).getByText("Drafted by your agent")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send 2 drafts" }),
    ).toBeInTheDocument();
  });

  it("never shows drafts in the owner's view", async () => {
    const owner = { ...drafted, drafts: undefined };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/overview")
          ? { ok: true, json: async () => ({ sessions: [] }) }
          : {
              ok: true,
              json: async () => ({
                ...structuredClone(owner),
                respondent: false,
              }),
            },
      ),
    );
    render(<App />);
    expect(await screen.findByText("Budget?")).toBeInTheDocument();
    expect(screen.queryByText(/draft/i)).not.toBeInTheDocument();
  });
});

describe("assigning on the Free plan", () => {
  it("shows Assign as a Pro feature, with the way to upgrade", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/me")
          ? {
              ok: true,
              json: async () => ({
                email: "ann@example.com",
                plan: { plan: "free", source: null, billing: true },
              }),
            }
          : String(url).endsWith("/overview")
            ? { ok: true, json: async () => ({ sessions: [] }) }
            : { ok: true, json: async () => structuredClone(state) },
      ),
    );
    render(<App />);
    await screen.findByText("Choose a direction");
    const button = await screen.findByRole("button", { name: "Assign Pro" });
    fireEvent.click(button);
    expect(screen.getByText(/is a Pro feature/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Upgrade to Pro" }),
    ).toHaveAttribute("href", "/pricing");
    expect(
      within(screen.getByRole("dialog", { name: "Assign" })).getByRole(
        "textbox",
      ),
    ).toBeDisabled();
  });
});

describe("questionnaire UI seam", () => {
  it("does not close an already-closed state socket during refresh cleanup", async () => {
    const { unmount } = render(<App />);
    await screen.findByText("Choose a direction");
    const socket = FakeSocket.instances[0]!;
    socket.readyState = FakeSocket.CLOSED;

    unmount();

    expect(socket.close).not.toHaveBeenCalled();
  });

  it("reconnects the state socket after an unexpected close", async () => {
    render(<App />);
    await screen.findByText("Choose a direction");
    vi.useFakeTimers();

    await act(async () => {
      FakeSocket.instances[0]!.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(FakeSocket.instances).toHaveLength(2);
    vi.useRealTimers();
  });

  it("stops reconnecting and says why when the interview is deleted", async () => {
    render(<App />);
    await screen.findByText("Choose a direction");
    vi.useFakeTimers();
    await act(async () => {
      FakeSocket.instances[0]!.onclose?.({ code: 4404 });
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(FakeSocket.instances).toHaveLength(1);
    vi.useRealTimers();
    expect(screen.getByText("This interview was deleted.")).toBeVisible();
  });

  it("renders the interview title above the questions", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Todo list product interview",
      }),
    ).toBeInTheDocument();
  });

  it("collapses saved answers, shows receipts, sanitizes recommendations, and permits revision", async () => {
    const { container } = render(<App />);
    expect(await screen.findByText("Choose a direction")).toBeInTheDocument();
    expect(container.querySelector(".answer-summary")).toHaveTextContent("A");
    expect(screen.getByLabelText("Saved")).toBeInTheDocument();
    expect(container.querySelector(".question")).toHaveClass("received");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("A", { selector: "strong" })).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("button", { name: "A" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Other answer or note")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Skip" })).toBeEnabled();
  });

  it("collapses and displays an answer that arrives from Gemini", async () => {
    const unanswered = structuredClone(state);
    unanswered.questions[0]!.answer = null;
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => structuredClone(unanswered),
    } as Response);
    const { container } = render(<App />);
    await screen.findByText("Choose a direction");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await act(async () => {
      FakeSocket.instances[0]!.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "state", session: state }),
        }),
      );
    });

    expect(container.querySelector(".answer-summary")).toHaveTextContent("A");
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("marks the switcher when another interview is waiting on the user", async () => {
    overview = [
      summary({}),
      summary({
        id: "s2",
        token: "other",
        title: "Checkout flow",
        open: 3,
        answered: 0,
        total: 3,
        project: {
          id: "p2",
          key: "github.com/o/frockbot",
          name: "FrockBot",
          color: "#7a2e8f",
        },
      }),
      summary({
        id: "s3",
        token: "done",
        title: "Old one",
        status: "stopped",
        open: 0,
      }),
    ];
    render(<App />);
    expect(
      await screen.findByLabelText("1 other interview waiting on you"),
    ).toHaveTextContent("1");
    fireEvent.click(
      screen.getByRole("button", { name: /Todo list product interview/ }),
    );
    const menu = screen.getByRole("dialog", { name: "Switch interview" });
    expect(menu).toHaveTextContent("FrockBot");
    expect(menu).toHaveTextContent("3 open");
    expect(menu).toHaveTextContent("Stopped");
    fireEvent.change(screen.getByLabelText("Search interviews"), {
      target: { value: "frock" },
    });
    expect(menu).not.toHaveTextContent("Old one");
    expect(menu).toHaveTextContent("Checkout flow");
  });

  it("pre-selects and marks the default, then accepts it in one click", async () => {
    const withDefault = structuredClone(state);
    withDefault.questions[0] = {
      ...withDefault.questions[0]!,
      type: "multiple-choice",
      options: ["A", "B", "C"],
      default: ["A", "C"],
      answer: null,
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => structuredClone(withDefault),
    } as Response);
    render(<App />);
    await screen.findByText("Choose a direction");

    expect(
      screen.getByRole("button", { name: "A Recommended" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Re-picking a default in a different order still matches it.
    fireEvent.click(screen.getByRole("button", { name: "A Recommended" }));
    fireEvent.click(screen.getByRole("button", { name: "A Recommended" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept default" }));

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/questions/q1/answer"),
        expect.objectContaining({
          body: JSON.stringify({ answer: "A, C", skipped: false }),
        }),
      ),
    );
  });

  it("switches to Save and appends a note once the user departs from the default", async () => {
    const withDefault = structuredClone(state);
    withDefault.questions[0] = {
      ...withDefault.questions[0]!,
      default: ["A"],
      answer: null,
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => structuredClone(withDefault),
    } as Response);
    render(<App />);
    await screen.findByText("Choose a direction");

    fireEvent.click(screen.getByRole("button", { name: "B" }));
    fireEvent.change(screen.getByLabelText("Other answer or note"), {
      target: { value: "only for now" },
    });
    expect(
      screen.getByRole("button", { name: "A Recommended" }),
    ).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/questions/q1/answer"),
        expect.objectContaining({
          body: JSON.stringify({ answer: "B — only for now", skipped: false }),
        }),
      ),
    );
  });

  it("accepts every untouched default from the header", async () => {
    const many = structuredClone(state);
    const base = { ...many.questions[0]!, answer: null };
    many.questions = [
      { ...base, id: "q1", prompt: "First", default: ["A"] },
      { ...base, id: "q2", prompt: "Second", default: ["B"] },
      { ...base, id: "q3", prompt: "No default", default: null },
    ];
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => structuredClone(many),
    } as Response);
    render(<App />);
    await screen.findByText("First");

    // Touching a question's form exempts it from the bulk accept.
    fireEvent.click(screen.getAllByRole("button", { name: "A" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Accept 1 default" }));

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/questions/q1/answer"),
        expect.objectContaining({ body: JSON.stringify({ answer: "A" }) }),
      ),
    );
    const posted = vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posted).toHaveLength(1);
  });

  it("distinguishes skipped answers and shows progress", async () => {
    const skipped = structuredClone(state);
    skipped.questions[0]!.answer!.skipped = true;
    skipped.questions[0]!.answer!.text = "";
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => structuredClone(skipped),
    } as Response);
    render(<App />);
    await screen.findByText("Choose a direction");

    expect(screen.getByLabelText("Skipped")).toBeInTheDocument();
    expect(screen.queryByLabelText("Saved locally")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 1 answered")).toBeInTheDocument();
  });

  describe("question navigation", () => {
    const threeQuestions = () => {
      const next = structuredClone(state);
      for (const id of ["q2", "q3"])
        next.questions.push({
          ...structuredClone(state.questions[0]!),
          id,
          prompt: `Question ${id}`,
          answer: null,
        });
      vi.mocked(fetch).mockImplementation(
        async () =>
          ({ ok: true, json: async () => structuredClone(next) }) as Response,
      );
    };

    class FakeObserver {
      static instances: FakeObserver[] = [];
      targets: Element[] = [];
      constructor(readonly callback: IntersectionObserverCallback) {
        FakeObserver.instances.push(this);
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      disconnect() {
        this.targets = [];
      }
      /** Reports every observed card as below the fold or on screen. */
      report(below: boolean) {
        this.callback(
          this.targets.map(
            (target) =>
              ({
                target,
                isIntersecting: !below,
                boundingClientRect: { top: below ? 900 : 100 },
                rootBounds: { bottom: 700 },
              }) as unknown as IntersectionObserverEntry,
          ),
          this as unknown as IntersectionObserver,
        );
      }
    }
    const latestObserver = () => FakeObserver.instances.at(-1)!;
    beforeEach(() => {
      FakeObserver.instances.length = 0;
      vi.stubGlobal("IntersectionObserver", FakeObserver);
    });

    it("counts answered questions over the questions", async () => {
      threeQuestions();
      render(<App />);
      expect(await screen.findByText("1 of 3 answered")).toBeInTheDocument();
    });

    it("hides the progress when there are no questions", async () => {
      const empty = structuredClone(state);
      empty.questions = [];
      vi.mocked(fetch).mockImplementation(
        async () =>
          ({ ok: true, json: async () => structuredClone(empty) }) as Response,
      );
      render(<App />);
      await screen.findByText("No questions yet");
      expect(screen.queryByText(/answered$/)).not.toBeInTheDocument();
    });

    it("points to open questions below the fold and scrolls to the next one", async () => {
      threeQuestions();
      render(<App />);
      await screen.findByText("Question q3");
      expect(latestObserver().targets).toHaveLength(2);
      expect(
        screen.queryByText(/more questions? below/),
      ).not.toBeInTheDocument();

      act(() => latestObserver().report(true));
      const pill = screen.getByRole("button", {
        name: "↓ 2 more questions below",
      });
      const scrollIntoView = vi.fn();
      latestObserver().targets[0]!.scrollIntoView = scrollIntoView;
      fireEvent.click(pill);
      expect(scrollIntoView).toHaveBeenCalled();

      act(() => latestObserver().report(false));
      expect(
        screen.queryByText(/more questions? below/),
      ).not.toBeInTheDocument();
    });

    it("renders without IntersectionObserver", async () => {
      vi.stubGlobal("IntersectionObserver", undefined);
      threeQuestions();
      render(<App />);
      expect(await screen.findByText("1 of 3 answered")).toBeInTheDocument();
      expect(
        screen.queryByText(/more questions? below/),
      ).not.toBeInTheDocument();
    });
  });

  it("accepts free text for number questions", async () => {
    const numeric = structuredClone(state);
    numeric.questions[0] = {
      ...numeric.questions[0]!,
      type: "number",
      options: [],
      min: 0,
      max: 50,
      answer: null,
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => structuredClone(numeric),
    } as Response);
    render(<App />);
    await screen.findByText("Choose a direction");

    const input = screen.getByLabelText("Your answer");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("placeholder", "Number (0–50) or a note");
    fireEvent.change(input, { target: { value: "depends on region" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  describe("workspace", () => {
    const artifact = (
      overrides: Partial<SessionView["artifacts"][number]>,
    ): SessionView["artifacts"][number] => ({
      id: "plan",
      kind: "plan",
      title: "Plan",
      format: overrides.kind && overrides.kind !== "plan" ? "html" : "markdown",
      content: "",
      size: 0,
      description: null,
      revision: 1,
      updatedAt: "",
      ...overrides,
    });
    const workspace = () => {
      const next = structuredClone(state);
      next.stageVisible = true;
      next.artifacts = [
        artifact({
          content:
            "## Decisions\n\n| Area | Choice |\n|---|---|\n| Data | Local-first |",
        }),
        artifact({
          id: "a",
          kind: "mockup",
          title: "Layout A",
          content: "<main>Sidebar layout</main>",
          description: "Sidebar navigation",
        }),
        artifact({
          id: "b",
          kind: "mockup",
          title: "Layout B",
          content: "<main>Board layout</main>",
        }),
      ];
      return next;
    };
    const serve = (session: SessionView) =>
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => structuredClone(session),
      } as Response);
    const posts = (suffix: string) =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith(suffix))
        .map(([, init]) => JSON.parse(String(init?.body)));
    const frame = (title: string) =>
      [...document.querySelectorAll(".react-flow__node-frame .frame")].find(
        (node) => node.querySelector(".frame-name")?.textContent === title,
      ) as HTMLElement | undefined;
    // React Flow measures nodes and the pane; jsdom has no layout, so it gets an observer that never fires.
    beforeEach(() => {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
    });
    const layoutQuestion = (session: SessionView) => {
      session.questions[0] = {
        ...session.questions[0]!,
        prompt: "Which layout?",
        options: ["Sidebar", "Board"],
        optionArtifacts: { Sidebar: "a", Board: "b" },
        default: ["Sidebar"],
        answer: null,
      };
      return session;
    };
    const fontQuestion = (session: SessionView) => {
      session.questions[0] = {
        ...session.questions[0]!,
        prompt: "Display font?",
        options: ["Inter", "Fraunces"],
        artifactId: "a",
        optionValues: {
          Inter: { "--font-display": "Inter" },
          Fraunces: { "--font-display": "Fraunces" },
        },
        default: null,
        answer: null,
      };
      return session;
    };

    it("keeps the canvas closed until someone opens it", async () => {
      const closed = workspace();
      closed.stageVisible = false;
      serve(closed);
      const { container } = render(<App />);
      await screen.findByText("Choose a direction");
      expect(container.querySelector(".react-flow")).toBeNull();
      const toggle = screen.getByRole("button", { name: /Canvas/ });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(toggle);
      await vi.waitFor(() =>
        expect(posts("/stage/visibility")).toEqual([{ visible: true }]),
      );
    });

    it("lays designs out as frames, a row per question, and leaves documents off", async () => {
      serve(layoutQuestion(workspace()));
      const { container } = render(<App />);
      await screen.findByText("Which layout?");
      await vi.waitFor(() => expect(frame("Layout B")).toBeDefined());
      expect(
        [...container.querySelectorAll(".row-label")].map(
          (row) => row.textContent,
        ),
      ).toEqual(["Question 1Which layout?"]);
      // The plan is a document: it's on the Document tab, not the canvas.
      expect(frame("Plan")).toBeUndefined();
      const node = (id: string) =>
        (
          container.querySelector(
            `.react-flow__node[data-id="${id}"]`,
          ) as HTMLElement
        ).style.transform.replace(/,\s*/, ", ");
      expect(node("a")).toBe("translate(0px, 0px)");
      expect(node("b")).toBe("translate(1400px, 0px)");
    });

    it("puts a frame where someone moved it, and the rest where they were", async () => {
      const session = layoutQuestion(workspace());
      session.positions = { b: { x: 300, y: -900 } };
      serve(session);
      const { container } = render(<App />);
      await vi.waitFor(() => expect(frame("Layout B")).toBeDefined());
      const node = (id: string) =>
        (
          container.querySelector(
            `.react-flow__node[data-id="${id}"]`,
          ) as HTMLElement
        ).style.transform.replace(/,\s*/, ", ");
      expect(node("b")).toBe("translate(300px, -900px)");
      expect(node("a")).toBe("translate(0px, 0px)");
    });

    /** Without the plan, the mockups are the first row, in view in jsdom's unsized canvas. */
    const withoutPlan = (session: SessionView) => {
      session.artifacts = session.artifacts.filter(
        (item) => item.id !== "plan",
      );
      return session;
    };

    it("loads a mockup frame from its own sandboxed URL", async () => {
      serve(withoutPlan(layoutQuestion(workspace())));
      render(<App />);
      await vi.waitFor(() =>
        expect(frame("Layout A")?.querySelector("iframe")).toBeTruthy(),
      );
      const iframe = frame("Layout A")!.querySelector("iframe")!;
      expect(iframe.getAttribute("src")).toMatch(
        /\/artifacts\/a\/view\?rev=1&theme=light$/,
      );
      // The server's CSP sandbox isolates it; embedded browsers can refuse
      // to load frames that also carry the sandbox attribute.
      expect(iframe).not.toHaveAttribute("sandbox");
    });

    it("lights up the frame of the option under the pointer, and marks the one chosen", async () => {
      serve(layoutQuestion(workspace()));
      render(<App />);
      await vi.waitFor(() => expect(frame("Layout B")).toBeDefined());
      expect(frame("Layout A")).toHaveClass("picked");
      expect(within(frame("Layout A")!).getByText("Selected")).toBeTruthy();
      const board = screen.getByRole("button", { name: "Board" });
      fireEvent.mouseEnter(board);
      await vi.waitFor(() => expect(frame("Layout B")).toHaveClass("hot"));
      fireEvent.mouseLeave(board);
      fireEvent.click(board);
      await vi.waitFor(() => expect(frame("Layout B")).toHaveClass("picked"));
      expect(frame("Layout B")).not.toHaveClass("hot");
      expect(frame("Layout A")).not.toHaveClass("picked");
    });

    it("previews a bound option in the mockup's frame on hover, and keeps a pick", async () => {
      const session = withoutPlan(fontQuestion(workspace()));
      session.artifacts = session.artifacts.filter((item) => item.id === "a");
      serve(session);
      const { container } = render(<App />);
      await vi.waitFor(() =>
        expect(frame("Layout A")?.querySelector("iframe")).toBeTruthy(),
      );
      const iframe = frame("Layout A")!.querySelector("iframe")!;
      const sent = vi.spyOn(iframe.contentWindow!, "postMessage");
      const lastValues = () => sent.mock.calls.at(-1)?.[0];
      const fraunces = screen.getByRole("button", { name: "Fraunces" });

      fireEvent.mouseEnter(fraunces);
      await vi.waitFor(() =>
        expect(lastValues()).toEqual({
          type: "kim-set",
          values: { "--font-display": "Fraunces" },
        }),
      );
      expect(within(frame("Layout A")!).getByText("Fraunces")).toBeTruthy();
      fireEvent.mouseLeave(fraunces);
      await vi.waitFor(() =>
        expect(lastValues()).toEqual({ type: "kim-set", values: {} }),
      );
      fireEvent.click(fraunces);
      fireEvent.mouseLeave(fraunces);
      await vi.waitFor(() =>
        expect(lastValues()).toEqual({
          type: "kim-set",
          values: { "--font-display": "Fraunces" },
        }),
      );
      // Each option's card shows the mockup with it applied.
      expect(container.querySelectorAll(".choice-card iframe")).toHaveLength(2);
      // Nothing was saved: previews stay in the page.
      expect(posts("/answer")).toEqual([]);
    });

    it("compares a bound choice side by side, and picks an option from its copy", async () => {
      serve(fontQuestion(workspace()));
      render(<App />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Compare side by side" }),
      );
      await vi.waitFor(() => expect(frame("Layout A · Inter")).toBeDefined());
      expect(frame("Layout A · Fraunces")).toBeDefined();
      fireEvent.click(
        within(frame("Layout A · Fraunces")!).getByText("Use Fraunces"),
      );
      expect(screen.getByRole("button", { name: "Fraunces" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await vi.waitFor(() =>
        expect(
          within(frame("Layout A · Fraunces")!).getByText("Selected"),
        ).toBeTruthy(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Hide comparison" }));
      await vi.waitFor(() => expect(frame("Layout A · Inter")).toBeUndefined());
    });

    it("opens a frame at full size, with device widths, and backs out with Esc", async () => {
      serve(layoutQuestion(workspace()));
      const { container } = render(<App />);
      await vi.waitFor(() => expect(frame("Layout A")).toBeDefined());
      fireEvent.click(
        frame("Layout A")!.querySelector('[aria-label="Preview Layout A"]')!,
      );
      const preview = await screen.findByRole("dialog", {
        name: "Preview of Layout A",
      });
      expect(
        within(preview).getByRole("button", { name: /Desktop/ }),
      ).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(within(preview).getByRole("button", { name: /Mobile/ }));
      expect(
        within(preview).getByRole("button", { name: /Mobile/ }),
      ).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(within(preview).getByTitle("Open full screen"));
      expect(container.querySelector(".preview.full")).not.toBeNull();
      // Comment mode, then full screen, then the preview itself.
      fireEvent.keyDown(window, { key: "c" });
      expect(
        within(preview).getByRole("button", { name: "Comment" }),
      ).toHaveAttribute("aria-pressed", "true");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(
        within(preview).getByRole("button", { name: "Comment" }),
      ).toHaveAttribute("aria-pressed", "false");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(container.querySelector(".preview.full")).toBeNull();
      // Esc pressed inside the artifact comes up from its frame.
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "kim-key", key: "Escape" },
          source: preview.querySelector("iframe")!.contentWindow,
        }),
      );
      await vi.waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
    });

    it("ignores Esc from a window that isn't one of its frames", async () => {
      serve(layoutQuestion(workspace()));
      render(<App />);
      await vi.waitFor(() => expect(frame("Layout A")).toBeDefined());
      fireEvent.doubleClick(frame("Layout A")!.querySelector(".frame-label")!);
      await screen.findByRole("dialog");
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "kim-key", key: "Escape" },
          source: window,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("pins a comment to a frame and sends it with the message", async () => {
      serve(layoutQuestion(workspace()));
      render(<App />);
      await vi.waitFor(() => expect(frame("Layout A")).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: /Comment/ }));
      fireEvent.click(frame("Layout A")!.querySelector(".frame-body")!, {
        clientX: 120,
        clientY: 80,
      });
      expect(
        await screen.findByText(
          "Pin 1 · page · Layout A",
          {},
          { timeout: 2000 },
        ),
      ).toBeInTheDocument();
      // The pin shows on the frame before it's sent.
      expect(frame("Layout A")!.querySelector(".pin")?.textContent).toBe("1");
      fireEvent.change(
        screen.getByRole("textbox", { name: "Message to the agent" }),
        {
          target: { value: "Shorter, please" },
        },
      );
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await vi.waitFor(() =>
        expect(posts("/chat")).toEqual([
          {
            text: "Shorter, please",
            questionId: null,
            pin: {
              artifactId: "a",
              element: "page",
              selector: null,
              x: 120,
              y: 80,
              fx: 0,
              fy: 0,
              width: 1280,
            },
          },
        ]),
      );
    });

    it("shows sent pins on their frame and in the chat", async () => {
      const session = layoutQuestion(workspace());
      session.chat = [
        {
          id: "m1",
          author: "user",
          text: "Wider",
          questionId: null,
          replyTo: null,
          delivered: false,
          createdAt: "",
          authorEmail: null,
          pin: {
            n: 3,
            artifactId: "a",
            element: "email field",
            selector: null,
            x: 300,
            y: 450,
            fx: 0.5,
            fy: 0.5,
            width: 1280,
          },
        },
      ];
      serve(session);
      render(<App />);
      expect(
        await screen.findByText("Pin 3 · email field · Layout A"),
      ).toBeInTheDocument();
      await vi.waitFor(() =>
        expect(frame("Layout A")!.querySelector(".pin")?.textContent).toBe("3"),
      );
    });

    it("shows an option's frame from its card", async () => {
      const session = layoutQuestion(workspace());
      session.stageVisible = false;
      serve(session);
      render(<App />);
      fireEvent.click(
        await screen.findByRole("button", { name: "View Board on the canvas" }),
      );
      // A closed canvas opens to show it.
      await vi.waitFor(() =>
        expect(posts("/stage/visibility")).toEqual([{ visible: true }]),
      );
    });

    describe("tabs", () => {
      beforeEach(() => localStorage.clear());
      const tab = (name: RegExp) => screen.getByRole("tab", { name });
      const panel = () => screen.getByRole("tabpanel");

      it("offers Document, HTML and Design, and remembers the one chosen", async () => {
        serve(layoutQuestion(workspace()));
        render(<App />);
        await vi.waitFor(() => expect(frame("Layout A")).toBeDefined());
        expect(
          screen.getAllByRole("tab").map((item) => item.textContent),
        ).toEqual(["Document1", "HTML2", "Design2"]);
        expect(tab(/Design/)).toHaveAttribute("aria-selected", "true");

        fireEvent.click(tab(/Document/));
        expect(within(panel()).getByText("Area").tagName).toBe("TH");
        expect(panel().querySelector(".react-flow")).toBeNull();
        expect(localStorage.getItem("kim.workspaceTab")).toBe("document");
      });

      it("hides a tab with nothing in it", async () => {
        serve(withoutPlan(workspace()));
        render(<App />);
        await screen.findByRole("tab", { name: /HTML/ });
        expect(screen.queryByRole("tab", { name: /Document/ })).toBeNull();
      });

      it("shows a page at a device's width, rotated, reloaded or on its own", async () => {
        serve(layoutQuestion(workspace()));
        render(<App />);
        fireEvent.click(await screen.findByRole("tab", { name: /HTML/ }));
        const page = within(panel());
        // What's in hand first: the default option's mockup.
        const picker = page.getByRole("combobox", { name: "Page" });
        expect(picker).toHaveValue("a");
        expect(panel().querySelector("iframe")!.getAttribute("src")).toMatch(
          /\/artifacts\/a\/view\?/,
        );
        fireEvent.change(picker, { target: { value: "b" } });
        expect(panel().querySelector("iframe")!.getAttribute("src")).toMatch(
          /\/artifacts\/b\/view\?/,
        );
        expect(page.queryByRole("button", { name: /Rotate/ })).toBeNull();
        fireEvent.click(page.getByRole("button", { name: /Mobile/ }));
        fireEvent.click(page.getByRole("button", { name: /Rotate/ }));
        expect(page.getByRole("button", { name: /Rotate/ })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        const before = panel().querySelector("iframe");
        fireEvent.click(page.getByRole("button", { name: "Reload" }));
        expect(panel().querySelector("iframe")).not.toBe(before);
        expect(
          page.getByRole("link", { name: "Open in a new tab" }),
        ).toHaveAttribute(
          "href",
          expect.stringMatching(/\/artifacts\/b\/view\?/),
        );
        // The tab is the page: nothing to close.
        expect(
          page.queryByRole("button", { name: "Close preview" }),
        ).toBeNull();
      });

      it("goes to the tab that holds what a question shows", async () => {
        serve(layoutQuestion(workspace()));
        render(<App />);
        fireEvent.click(await screen.findByRole("tab", { name: /Document/ }));
        fireEvent.click(
          screen.getByRole("button", { name: "View Board on the canvas" }),
        );
        await vi.waitFor(() =>
          expect(tab(/HTML/)).toHaveAttribute("aria-selected", "true"),
        );
        expect(within(panel()).getByRole("combobox")).toHaveValue("b");
      });

      it("pins a comment to a page in its tab", async () => {
        serve(layoutQuestion(workspace()));
        render(<App />);
        fireEvent.click(await screen.findByRole("tab", { name: /HTML/ }));
        fireEvent.click(
          within(panel()).getByRole("button", { name: /Comment/ }),
        );
        fireEvent.click(panel().querySelector(".catcher")!);
        expect(
          await screen.findByText(
            "Pin 1 · page · Layout A",
            {},
            { timeout: 2000 },
          ),
        ).toBeInTheDocument();
        expect(
          within(panel()).getByRole("button", { name: /Comment/ }),
        ).toHaveAttribute("aria-pressed", "false");
      });
    });
  });
});
