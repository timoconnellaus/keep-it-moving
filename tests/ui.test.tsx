/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
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

    expect(screen.getByRole("button", { name: "A default" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Re-picking a default in a different order still matches it.
    fireEvent.click(screen.getByRole("button", { name: "A default" }));
    fireEvent.click(screen.getByRole("button", { name: "A default" }));
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
    expect(screen.getByRole("button", { name: "A default" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
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
    const stagePosts = () => posts("/stage");

    it("keeps the workspace closed until someone opens it", async () => {
      const closed = workspace();
      closed.stageVisible = false;
      serve(closed);
      render(<App />);
      await screen.findByText("Choose a direction");
      expect(screen.queryByRole("tab")).not.toBeInTheDocument();
      const toggle = screen.getByRole("button", { name: /Workspace/ });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(toggle);
      await vi.waitFor(() =>
        expect(posts("/stage/visibility")).toEqual([{ visible: true }]),
      );
    });

    it("closes the workspace from its own bar", async () => {
      serve(workspace());
      render(<App />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Hide the workspace" }),
      );
      await vi.waitFor(() =>
        expect(posts("/stage/visibility")).toEqual([{ visible: false }]),
      );
    });

    it("shows the plan beside the questions and switches items for everyone", async () => {
      serve(workspace());
      render(<App />);
      expect(
        await screen.findByRole("columnheader", { name: "Area" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Plan Plan" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      fireEvent.click(screen.getByRole("tab", { name: "Mockup Layout A" }));
      await vi.waitFor(() =>
        expect(stagePosts()).toEqual([{ artifactId: "a" }]),
      );
    });

    it("loads a staged mockup from its own sandboxed URL", async () => {
      const staged = workspace();
      staged.stage = { artifactId: "a", source: "agent" };
      serve(staged);
      render(<App />);
      const frame = await screen.findByTitle("Layout A");
      expect(frame.getAttribute("src")).toMatch(
        /\/artifacts\/a\/view\?rev=1&theme=light$/,
      );
      // The server's CSP sandbox isolates it; embedded browsers can refuse
      // to load frames that also carry the sandbox attribute.
      expect(frame).not.toHaveAttribute("sandbox");
      expect(screen.getByText("Sidebar navigation")).toBeInTheDocument();
      expect(screen.getByText("via agent")).toBeInTheDocument();
    });

    it("shows archify diagrams compactly, and in the full viewer when expanded", async () => {
      const session = workspace();
      session.artifacts.push(
        artifact({ id: "d", kind: "diagram", title: "Sync architecture" }),
      );
      session.stage = { artifactId: "d", source: "agent" };
      serve(session);
      render(<App />);
      const compact = await screen.findByTitle("Sync architecture");
      expect(compact.getAttribute("src")).toMatch(/theme=light&embed=1$/);
      fireEvent.click(screen.getByRole("button", { name: "Expand" }));
      const full = screen.getByTitle("Sync architecture");
      expect(full.getAttribute("src")).toMatch(
        /\/artifacts\/d\/view\?rev=1&theme=light$/,
      );
      // The stylesheet hides the questions for an expanded workspace.
      expect(full.closest(".workspace")).toHaveClass("expanded");
    });

    it("offers visual option cards and links a question to what it is about", async () => {
      const session = workspace();
      session.questions[0] = {
        ...session.questions[0]!,
        prompt: "Which layout?",
        options: ["Sidebar", "Board"],
        optionArtifacts: { Sidebar: "a", Board: "b" },
        default: ["Sidebar"],
        artifactId: "plan",
        answer: null,
      };
      serve(session);
      const { container } = render(<App />);
      await screen.findByText("Which layout?");

      expect(container.querySelectorAll(".choice-card iframe")).toHaveLength(2);
      expect(
        screen.getByRole("button", { name: "Sidebar default" }),
      ).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Board" }));
      expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      fireEvent.click(
        screen.getByRole("button", { name: "View Board in the workspace" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Plan" }));
      await vi.waitFor(() =>
        expect(stagePosts()).toEqual([
          { artifactId: "b" },
          { artifactId: "plan" },
        ]),
      );
    });
  });
});
