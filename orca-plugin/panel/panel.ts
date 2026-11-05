// The Interviews panel: the focused workspace's interview first, answered
// in place, then what else needs the user. It asks the plugin's worker for
// everything; the panel itself reaches nothing outside the plugin.
import type {
  InterviewRef,
  MockupView,
  OwnInterview,
  PanelState,
  SentInterview,
} from "../src/protocol";
import { mountMockup, type Mounted } from "./render";

interface OrcaFrame {
  plugin: {
    request(
      name: string,
      input?: unknown,
      options?: { timeoutMs?: number },
    ): Promise<any>;
    on(name: string, handler: (payload: any) => void): { dispose(): void };
  };
  shell?: { openExternal(url: string): Promise<{ opened: boolean }> };
}
declare const orca: OrcaFrame;

/** A question as either kind of interview gives it. */
interface Question {
  id: string;
  number: number;
  type: "text" | "single-choice" | "multiple-choice" | "yes-no" | "number";
  prompt: string;
  options: string[];
  default: string[] | null;
  recommendation: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  unit: string | null;
  artifactId: string | null;
  optionArtifacts: Record<string, string>;
  optionValues: Record<string, Record<string, string>>;
  control: string | null;
  answer: { text: string; skipped: boolean } | null;
}
interface Detail {
  questions: Question[];
  artifacts: Array<{
    id: string;
    title: string;
    format: string;
    revision: number;
  }>;
}

const app = document.getElementById("app")!;
let state: PanelState = {
  overview: null,
  problem: null,
  workspace: null,
  here: [],
};
let selected: InterviewRef | null = null;
const details = new Map<string, Detail>();
const mockups = new Map<string, Promise<MockupView>>();
let busy = false;
let notice = "";

const keyOf = (ref: InterviewRef) => `${ref.kind}:${ref.id}`;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith("on") && typeof value === "function")
      element.addEventListener(
        name.slice(2).toLowerCase(),
        value as EventListener,
      );
    else if (name === "className") element.className = String(value);
    else if (name in element && typeof value !== "string")
      (element as any)[name] = value;
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

/** Bold, italics and code in an agent's short text; everything else as text. */
function inline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_|\*[^*]+\*)/g;
  let last = 0;
  for (const match of text.replace(/\\n/g, "\n").matchAll(pattern)) {
    fragment.append(text.slice(last, match.index));
    const token = match[0];
    fragment.append(
      token.startsWith("**")
        ? h("strong", {}, token.slice(2, -2))
        : token.startsWith("`")
          ? h("code", {}, token.slice(1, -1))
          : h("em", {}, token.slice(1, -1)),
    );
    last = match.index! + token.length;
  }
  fragment.append(text.slice(last));
  return fragment;
}

// ---- Data ----

async function loadDetail(ref: InterviewRef, fresh = false): Promise<Detail> {
  const key = keyOf(ref);
  if (!fresh && details.has(key)) return details.get(key)!;
  const raw = await orca.plugin.request("interview.get", ref);
  const detail: Detail = {
    artifacts: raw.artifacts ?? [],
    questions: (raw.questions ?? []).map((question: any, index: number) => ({
      id: question.id,
      number: question.number ?? index + 1,
      type: question.type,
      prompt: question.prompt,
      options: question.options ?? [],
      default: question.default ?? null,
      recommendation: question.recommendation ?? null,
      min: question.min ?? null,
      max: question.max ?? null,
      step: question.step ?? null,
      unit: question.unit ?? null,
      artifactId: question.artifactId ?? question.artifact?.id ?? null,
      optionArtifacts: question.optionArtifacts ?? {},
      optionValues: question.optionValues ?? {},
      control: question.control ?? null,
      answer: question.answer ?? null,
    })),
  };
  details.set(key, detail);
  return detail;
}

function mockup(
  ref: InterviewRef,
  artifactId: string,
  revision: number,
): Promise<MockupView> {
  const key = `${keyOf(ref)}:${artifactId}:${revision}`;
  if (!mockups.has(key)) {
    const loading = orca.plugin.request(
      "artifact.get",
      { ref, artifactId },
      { timeoutMs: 60_000 },
    );
    loading.catch(() => mockups.delete(key));
    mockups.set(key, loading);
  }
  return mockups.get(key)!;
}

// ---- Rendering ----

function render() {
  const scroll = app.scrollTop;
  app.replaceChildren(...view());
  app.scrollTop = scroll;
}

function view(): Node[] {
  const nodes: Node[] = [];
  if (state.problem) nodes.push(problemView());
  const overview = state.overview;
  if (!overview) {
    if (!state.problem)
      nodes.push(
        h("p", { className: "muted pad" }, "Looking for your interviews…"),
      );
    return nodes;
  }
  const own = new Map(overview.sessions.map((item) => [item.id, item]));
  const here = state.here
    .map((id) => own.get(id))
    .filter((item): item is OwnInterview => Boolean(item));
  const current =
    selected ?? (here[0] ? { kind: "own" as const, id: here[0].id } : null);
  if (notice)
    nodes.push(h("div", { className: "notice", role: "status" }, notice));

  if (current) {
    const isHere = current.kind === "own" && state.here.includes(current.id);
    nodes.push(
      h(
        "h3",
        {},
        isHere
          ? `This workspace${state.workspace ? ` · ${state.workspace.name}` : ""}`
          : "Interview",
        selected
          ? h(
              "button",
              {
                className: "link small",
                onClick: () => ((selected = null), render()),
              },
              "Back",
            )
          : null,
      ),
    );
    const item =
      current.kind === "own"
        ? own.get(current.id)
        : overview.inbox.find((sent) => sent.id === current.id);
    if (item) nodes.push(card(current, item));
  } else if (state.workspace) {
    nodes.push(
      h("h3", {}, `This workspace · ${state.workspace.name}`),
      h("p", { className: "muted pad" }, "No interview started here."),
    );
  }

  const others = here.filter((item) => item.id !== current?.id);
  if (others.length)
    nodes.push(
      h("h3", {}, "Also here"),
      list(others.map((item) => ownRow(item))),
    );

  const sent = overview.inbox.filter(
    (item) =>
      item.status === "active" &&
      !(current?.kind === "sent" && current.id === item.id),
  );
  if (sent.length)
    nodes.push(h("h3", {}, "Sent to you"), list(sent.map(sentRow)));

  const elsewhere = overview.sessions
    .filter(
      (item) =>
        !state.here.includes(item.id) &&
        item.id !== current?.id &&
        item.status === "active",
    )
    .sort(
      (a, b) =>
        Number(b.open > 0) - Number(a.open > 0) ||
        b.lastActivity.localeCompare(a.lastActivity),
    )
    .slice(0, 12);
  if (elsewhere.length)
    nodes.push(h("h3", {}, "Elsewhere"), list(elsewhere.map(ownRow)));
  if (!current && !sent.length && !elsewhere.length)
    nodes.push(
      h(
        "p",
        { className: "muted pad" },
        "No interviews yet. When an agent asks you something, it shows up here.",
      ),
    );
  return nodes;
}

function problemView(): Node {
  const problem = state.problem!;
  if (problem.kind === "missing")
    return h(
      "div",
      { className: "problem" },
      h("strong", {}, "Install kim to see your interviews"),
      h("p", {}, "In a terminal:"),
      h(
        "code",
        { className: "block" },
        "npm install -g https://keep-it-moving.zerobsai.com/cli.tgz",
      ),
      h(
        "p",
        {},
        "then ",
        h("code", {}, "kim login"),
        ". If kim is installed somewhere unusual, set its path in this plugin's settings.",
      ),
    );
  if (problem.kind === "signed-out")
    return h(
      "div",
      { className: "problem" },
      h("strong", {}, "Sign in to Keep it moving"),
      h("p", {}, "Run ", h("code", {}, "kim login"), " in a terminal."),
    );
  return h(
    "div",
    { className: "problem" },
    h("strong", {}, "Can't reach your interviews"),
    h("p", {}, problem.message),
  );
}

const list = (rows: Node[]) => h("div", { className: "list" }, ...rows);

function swatch(color: string | null | undefined) {
  return h("span", {
    className: "swatch",
    style: `background:${color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : "var(--orca-muted-foreground)"}`,
  });
}

function ownRow(item: OwnInterview): Node {
  return h(
    "button",
    { className: "row", onClick: () => select({ kind: "own", id: item.id }) },
    swatch(item.project?.color),
    h(
      "span",
      { className: "row-body" },
      h("span", { className: "row-title" }, item.title),
      h(
        "span",
        { className: "muted" },
        [
          item.origin.worktree ?? item.project?.name,
          `${item.answered} of ${item.total}`,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    ),
    badge(item),
  );
}

function sentRow(item: SentInterview): Node {
  return h(
    "button",
    { className: "row", onClick: () => select({ kind: "sent", id: item.id }) },
    swatch("#6b8cff"),
    h(
      "span",
      { className: "row-body" },
      h("span", { className: "row-title" }, item.title),
      h(
        "span",
        { className: "muted" },
        `From ${item.from ?? "someone"} · ${item.openQuestions} open`,
      ),
    ),
    h(
      "span",
      { className: "badge sent" },
      item.drafted ? `${item.drafted} drafted` : "Sent to you",
    ),
  );
}

function badge(item: OwnInterview): Node {
  if (item.status !== "active")
    return h("span", { className: "badge" }, "Done");
  if (item.assignee)
    return h("span", { className: "badge" }, `With ${item.assignee}`);
  if (item.open > 0)
    return h("span", { className: "badge wait" }, `${item.open} open`);
  if (item.awaitingReply)
    return h("span", { className: "badge" }, "Awaiting reply");
  return h(
    "span",
    { className: "badge work" },
    item.agentWatching ? "Agent waiting" : "Agent working",
  );
}

function select(ref: InterviewRef) {
  selected = ref;
  notice = "";
  render();
  app.scrollTop = 0;
}

function card(ref: InterviewRef, item: OwnInterview | SentInterview): Node {
  const own = ref.kind === "own" ? (item as OwnInterview) : null;
  const sent = ref.kind === "sent" ? (item as SentInterview) : null;
  const body = h(
    "div",
    { className: "card-body" },
    h("p", { className: "muted" }, "Loading…"),
  );
  const answered = own ? own.answered : 0;
  const total = own ? own.total : 0;
  const node = h(
    "section",
    { className: "card" },
    h(
      "div",
      { className: "card-head" },
      h("span", { className: "title" }, item.title),
      own ? badge(own) : h("span", { className: "badge sent" }, "Sent to you"),
    ),
    h(
      "div",
      { className: "muted" },
      own
        ? [own.origin.agent, own.origin.agentSession, own.origin.branch]
            .filter(Boolean)
            .join(" · ")
        : `From ${sent!.from ?? "someone"}`,
    ),
    own && total
      ? h(
          "div",
          { className: "progress" },
          h("i", { style: `width:${Math.round((answered / total) * 100)}%` }),
        )
      : null,
    h(
      "div",
      { className: "actions" },
      h(
        "button",
        {
          className: "link",
          onClick: () => void open(item.url, own?.origin.worktree ?? null),
        },
        "Open in browser ↗",
      ),
      sent
        ? h(
            "button",
            { className: "button", onClick: () => void startAgent(sent) },
            "Start an Agent",
          )
        : null,
    ),
    body,
  );
  void loadDetail(ref)
    .then((detail) =>
      body.replaceChildren(...questionView(ref, detail, item.url)),
    )
    .catch((error: Error) =>
      body.replaceChildren(h("p", { className: "error" }, error.message)),
    );
  return node;
}

function questionView(ref: InterviewRef, detail: Detail, url: string): Node[] {
  const open = detail.questions.filter((question) => !question.answer);
  if (!open.length)
    return [
      h(
        "p",
        { className: "muted" },
        detail.questions.length
          ? "Every question is answered."
          : "No questions yet.",
      ),
    ];
  const question = open[0]!;
  const nodes: Node[] = [
    h(
      "div",
      { className: "muted q-number" },
      `Question ${question.number} of ${detail.questions.length}`,
    ),
    h("div", { className: "q" }, inline(question.prompt)),
  ];
  nodes.push(form(ref, detail, question, url));
  if (question.recommendation)
    nodes.push(
      h(
        "div",
        { className: "rec-text" },
        h("span", { "aria-hidden": "true" }, "→ "),
        inline(question.recommendation),
      ),
    );
  if (open[1])
    nodes.push(
      h("div", { className: "muted then" }, "Then: ", inline(open[1].prompt)),
    );
  return nodes;
}

function form(
  ref: InterviewRef,
  detail: Detail,
  question: Question,
  url: string,
): Node {
  const choices = question.type === "yes-no" ? ["Yes", "No"] : question.options;
  const multiple = question.type === "multiple-choice";
  const chosen = new Set<string>(question.default ?? []);
  const artifactFor = (id: string | undefined) =>
    detail.artifacts.find((artifact) => artifact.id === id);
  const bound =
    question.artifactId && Object.keys(question.optionValues).length
      ? artifactFor(question.artifactId)
      : undefined;
  let preview: Mounted | null = null;
  const valuesFor = (option: string | null) =>
    option ? (question.optionValues[option] ?? {}) : {};
  const save = h(
    "button",
    { className: "button primary", disabled: true },
    "Save",
  );
  const container = h("div", { className: "form" });
  const update = () => {
    save.disabled = busy || (choices.length > 0 && chosen.size === 0);
    for (const element of container.querySelectorAll<HTMLElement>(
      "[data-option]",
    )) {
      const on = chosen.has(element.dataset.option!);
      element.classList.toggle("on", on);
      element.setAttribute("aria-pressed", String(on));
    }
    if (preview && !multiple) preview.apply(valuesFor([...chosen][0] ?? null));
  };
  const pick = (option: string) => {
    if (multiple)
      chosen.has(option) ? chosen.delete(option) : chosen.add(option);
    else {
      chosen.clear();
      chosen.add(option);
    }
    update();
  };

  if (bound) {
    const host = h("div", { className: "shot wide" });
    container.append(host);
    void mockup(ref, bound.id, bound.revision)
      .then((view) => (preview = drawMockup(host, view, update)))
      .catch(() =>
        host.replaceChildren(
          h("span", { className: "muted" }, "Preview unavailable"),
        ),
      );
  }

  const cards = choices.some((option) =>
    artifactFor(question.optionArtifacts[option]),
  );
  if (cards) {
    container.append(
      h(
        "div",
        { className: "cards" },
        ...choices.map((option) => {
          const artifact = artifactFor(question.optionArtifacts[option]);
          const host = h("div", { className: "shot" });
          if (artifact)
            void mockup(ref, artifact.id, artifact.revision)
              .then((view) => drawMockup(host, view))
              .catch(() =>
                host.replaceChildren(
                  h("span", { className: "muted" }, artifact.title),
                ),
              );
          return h(
            "div",
            {
              className: "option-card",
              "data-option": option,
              role: "button",
              tabindex: "0",
              onClick: () => pick(option),
              onKeydown: (event: KeyboardEvent) =>
                (event.key === "Enter" || event.key === " ") &&
                (event.preventDefault(), pick(option)),
            },
            host,
            h(
              "div",
              { className: "option-label" },
              h("span", {}, inline(option)),
              question.default?.includes(option)
                ? h("span", { className: "rec" }, "Recommended")
                : null,
              artifact
                ? h(
                    "button",
                    {
                      className: "link small view",
                      onClick: (event: Event) => (
                        event.stopPropagation(),
                        void open(url, null)
                      ),
                    },
                    "View",
                  )
                : null,
            ),
          );
        }),
      ),
    );
  } else if (choices.length) {
    container.append(
      ...choices.map((option) =>
        h(
          "button",
          {
            className: `option${multiple ? " multiple" : ""}`,
            "data-option": option,
            onClick: () => pick(option),
            onMouseenter: () => preview?.apply(valuesFor(option)),
            onMouseleave: () =>
              preview?.apply(
                valuesFor(multiple ? null : ([...chosen][0] ?? null)),
              ),
          },
          h("i", { className: "mark", "aria-hidden": "true" }),
          h("span", {}, inline(option)),
          question.default?.includes(option)
            ? h("span", { className: "rec" }, "Recommended")
            : null,
        ),
      ),
    );
  }

  let text: HTMLInputElement | HTMLTextAreaElement | null = null;
  const note = h("input", {
    className: "input",
    placeholder: choices.length ? "Other, or add a note" : "",
    type: "text",
  });
  if (!choices.length) {
    text =
      question.type === "number"
        ? h("input", {
            className: "input",
            type: "text",
            inputMode: "decimal",
            placeholder: rangeHint(question),
            value: question.default?.[0] ?? "",
          })
        : h(
            "textarea",
            { className: "input", rows: 3, placeholder: "Your answer" },
            question.default?.[0] ?? "",
          );
    text.addEventListener("input", () => {
      save.disabled = busy || !text!.value.trim();
      if (preview && question.control) {
        const value = text!.value.trim();
        preview.apply(
          value
            ? {
                [question.control]:
                  question.type === "number"
                    ? `${value}${question.unit ?? ""}`
                    : value,
              }
            : {},
        );
      }
    });
    container.append(text);
    save.disabled = !text.value.trim();
  } else container.append(note);

  save.addEventListener(
    "click",
    () =>
      void submit(ref, question, {
        ...(choices.length
          ? { options: [...chosen] }
          : { answer: text!.value.trim() }),
        ...(note.value.trim() ? { note: note.value.trim() } : {}),
      }),
  );
  const skip = h(
    "button",
    {
      className: "button",
      onClick: () => void submit(ref, question, { skipped: true }),
    },
    "Skip",
  );
  container.append(h("div", { className: "actions" }, save, skip));
  if (choices.length) update();
  return container;
}

function rangeHint(question: Question): string {
  if (question.min !== null && question.max !== null)
    return `Number (${question.min}–${question.max})`;
  return "Number";
}

function drawMockup(
  host: HTMLElement,
  view: MockupView,
  after?: () => void,
): Mounted | null {
  if (!view.html) {
    host.replaceChildren(
      h(
        "span",
        { className: "muted" },
        view.limits.includes("too-big")
          ? "Too big to preview here"
          : view.title,
      ),
    );
    return null;
  }
  const mounted = mountMockup(
    host,
    view,
    host.clientWidth || 280,
    host.classList.contains("wide") ? 220 : 150,
  );
  after?.();
  return mounted;
}

async function submit(
  ref: InterviewRef,
  question: Question,
  parts: {
    options?: string[];
    answer?: string;
    note?: string;
    skipped?: boolean;
  },
) {
  if (busy) return;
  busy = true;
  notice = "";
  try {
    await orca.plugin.request("answer", {
      ref,
      question: question.id,
      ...parts,
    });
    await loadDetail(ref, true);
  } catch (error) {
    notice = `Couldn't save: ${(error as Error).message}`;
  } finally {
    busy = false;
    render();
  }
}

async function open(url: string, worktree: string | null) {
  const workspacePath = worktree ? null : (state.workspace?.path ?? null);
  const { opened } = await orca.plugin
    .request("open", { url, workspacePath })
    .catch(() => ({ opened: false }));
  // No orca CLI to open a tab with: the default browser, then.
  if (!opened) await orca.shell?.openExternal(url).catch(() => undefined);
}

async function startAgent(item: SentInterview) {
  const result = await orca.plugin.request("agent.start", {
    url: item.url,
    title: item.title,
  });
  notice = result.started
    ? "Started an agent to draft your answers. Review them before you send."
    : `Couldn't start an agent: ${result.reason}`;
  render();
}

// ---- Wiring ----

orca.plugin.on("state.changed", (next: PanelState) => {
  const before = JSON.stringify(state.overview);
  state = next;
  // Something changed: questions and answers may have too.
  if (JSON.stringify(next.overview) !== before) details.clear();
  render();
});
void orca.plugin.request("state.get").then((next: PanelState) => {
  state = next;
  render();
});
render();
