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
import type { SessionView } from "../src/shared/schema.js";

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
  focusSource: null,
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
      },
    },
  ],
  clarifications: [],
  notes: [],
  artifacts: [],
  stage: null,
  voice: { transcript: [], resumptionHandle: null },
};

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
  onclose: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED;
  });
  constructor() {
    FakeSocket.instances.push(this);
  }
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => structuredClone(state) })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  FakeSocket.instances.length = 0;
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

    act(() => {
      FakeSocket.instances[0]!.onclose?.();
      vi.advanceTimersByTime(1_000);
    });

    expect(FakeSocket.instances).toHaveLength(2);
    vi.useRealTimers();
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
    expect(screen.getByLabelText("Saved locally")).toBeInTheDocument();
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

  it("marks and scrolls to the question Gemini is discussing", async () => {
    const focused = structuredClone(state);
    focused.focusedQuestionId = "q1";
    focused.focusedQuestionIds = ["q1"];
    focused.focusSource = "gemini";
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => structuredClone(focused),
    } as Response);

    const { container } = render(<App />);
    await screen.findByText("Choose a direction");

    expect(container.querySelector(".question")).toHaveClass("gemini-focused");
    expect(screen.getByText("Gemini")).toBeInTheDocument();
    // Scrolling happens in an effect, which may run after the text appears.
    await vi.waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "center",
      }),
    );
  });

  it("exposes one microphone control without rendering a transcript", async () => {
    render(<App />);
    await screen.findByText("Choose a direction");
    expect(
      screen.getAllByRole("button", { name: "Start voice conversation" }),
    ).toHaveLength(1);
    expect(screen.queryByText(/Recent conversation/)).not.toBeInTheDocument();
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
    expect(screen.getByLabelText("1 of 1 questions done")).toBeInTheDocument();
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

  it("highlights every question in the group voice is discussing", async () => {
    const grouped = structuredClone(state);
    const base = grouped.questions[0]!;
    grouped.questions = [
      { ...base, id: "q1", prompt: "First" },
      { ...base, id: "q2", prompt: "Second" },
      { ...base, id: "q3", prompt: "Third" },
    ];
    grouped.focusedQuestionId = "q1";
    grouped.focusedQuestionIds = ["q1", "q2"];
    grouped.focusSource = "gemini";
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => structuredClone(grouped),
    } as Response);
    const { container } = render(<App />);
    await screen.findByText("First");

    const cards = container.querySelectorAll(".question");
    expect(
      Array.from(cards).map((card) =>
        card.classList.contains("gemini-focused"),
      ),
    ).toEqual([true, true, false]);
    expect(screen.getAllByText("Gemini")).toHaveLength(1);
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
    const stagePosts = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith("/stage"))
        .map(([, init]) => JSON.parse(String(init?.body)));

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
      staged.stage = { artifactId: "a", source: "gemini" };
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
      expect(screen.getByText("via Gemini")).toBeInTheDocument();
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
