// The plugin's worker: keeps `kim overview --watch` running, drives the
// status bar item and notifications, and answers the panel. It runs while
// the plugin is enabled (it has a status bar item).
import { readFileSync } from "node:fs";
import type { OrcaWorkerApi } from "orca/worker";
import {
  focusedWorkspace,
  interviewsIn,
  needing,
  NOTHING_SEEN,
  notifications,
  statusItem,
  type Seen,
} from "./attention";
import { openInOrca, runKim, watchOverview, type Runner } from "./kim";
import { prepareMockup, type Kit } from "./mockup";
import type {
  AnswerInput,
  InterviewRef,
  KimProblem,
  MockupView,
  Overview,
  PanelState,
  Workspace,
} from "./protocol";

const SEEN_KEY = "seen";
/** A plugin.request answer is at most 1 MiB; a mockup stays under this. */
const MOCKUP_MAX_CHARS = 900_000;

export default async function activate(orca: OrcaWorkerApi) {
  let overview: Overview | null = null;
  let problem: KimProblem | null = null;
  let workspaces: Workspace[] = [];
  let context: { branch: string; displayName: string } | null = null;
  let seen: Seen =
    ((await orca.storage.get(SEEN_KEY).catch(() => null)) as Seen | null) ??
    NOTHING_SEEN;
  let first = !(await orca.storage.get(SEEN_KEY).catch(() => null));

  const setting = async (key: string): Promise<string> => {
    try {
      const all = (await orca.host.call("settings.get", {})) as
        Record<string, unknown> | { values?: Record<string, unknown> };
      const values = (
        "values" in all && all.values ? all.values : all
      ) as Record<string, unknown>;
      return typeof values[key] === "string"
        ? (values[key] as string).trim()
        : "";
    } catch {
      return "";
    }
  };
  const runner: Runner = { kimCommand: () => setting("kimCommand") };

  const state = (): PanelState => {
    const workspace = focusedWorkspace(workspaces, context);
    return {
      overview,
      problem,
      workspace,
      here: overview
        ? interviewsIn(overview, workspace).map((item) => item.id)
        : [],
    };
  };
  const publish = () => orca.panels.post("state.changed", state());

  const refreshWorkspaces = async () => {
    try {
      workspaces = (
        (await orca.host.call("workspace.list", {})) as {
          workspaces: Workspace[];
        }
      ).workspaces;
    } catch {
      workspaces = [];
    }
  };
  await refreshWorkspaces();
  orca.events.on(
    "workspace.changed",
    async (event: {
      context: { branch: string; displayName: string } | null;
    }) => {
      context = event.context;
      if (!focusedWorkspace(workspaces, context)) await refreshWorkspaces();
      publish();
    },
  );
  orca.events.on(
    "workspace.created",
    () => void refreshWorkspaces().then(publish),
  );
  orca.events.on(
    "workspace.removed",
    () => void refreshWorkspaces().then(publish),
  );
  try {
    context = await orca.host.call("workspace.readContext", {});
  } catch {
    context = null;
  }

  const updateStatus = async () => {
    const item = overview
      ? statusItem(overview)
      : { visible: false, text: "", tooltip: "" };
    await orca.host
      .call("statusBar.update", {
        id: "waiting",
        visible: item.visible,
        ...(item.visible ? { text: item.text, tooltip: item.tooltip } : {}),
      })
      .catch((error: Error) => orca.log(`status bar: ${error.message}`));
  };

  watchOverview(
    runner,
    async (value) => {
      overview = value as Overview;
      problem = null;
      const result = notifications(overview, seen, Date.now(), first);
      first = false;
      seen = result.seen;
      await orca.storage.set(SEEN_KEY, seen).catch(() => undefined);
      for (const note of result.notes)
        await orca.host
          .call("notifications.show", { ...note })
          .catch(() => undefined);
      await updateStatus();
      publish();
    },
    (next) => {
      problem = next;
      publish();
    },
  );

  // The status bar item, and the palette: open what waits on the user.
  orca.commands.register("openWaiting", async () => {
    const next = overview ? needing(overview)[0] : undefined;
    if (!next) return "Nothing is waiting on you.";
    const workspace =
      next.kind === "own" ? workspaceFor(next.interview.origin.worktree) : null;
    await openInOrca(
      next.interview.url,
      workspace?.path ?? focusedWorkspace(workspaces, context)?.path ?? null,
    );
    return `Opened ${next.interview.title}`;
  });
  const workspaceFor = (worktree: string | null) =>
    worktree
      ? (workspaces.find((item) =>
          item.path.replace(/[\\/]+$/, "").endsWith(`/${worktree}`),
        ) ?? null)
      : null;

  // The panel's requests.
  orca.panels.handle("state.get", () => state());

  orca.panels.handle("interview.get", (ref: InterviewRef) =>
    ref.kind === "own"
      ? runKim(runner, ["session", "show", ref.id])
      : runKim(runner, ["inbox", "show", ref.id, "--peek"]),
  );

  const kit = loadKit();
  orca.panels.handle(
    "artifact.get",
    async ({ ref, artifactId }): Promise<MockupView> => {
      const raw = await runKim<{
        id: string;
        title: string;
        format: string;
        kind: string;
        revision: number;
        content: string;
        values: Record<string, string>;
        description?: string | null;
        frame?: { width: number; height: number | null };
      }>(
        runner,
        ref.kind === "own"
          ? ["artifact", "get", ref.id, artifactId, "--inline-images"]
          : [
              "inbox",
              "artifact",
              ref.id,
              artifactId,
              "--raw",
              "--inline-images",
            ],
      );
      const prepared =
        raw.format === "html"
          ? await prepareMockup(raw.content, await kit)
          : { html: raw.content, css: "", limits: [] };
      let html = prepared.html;
      // Too big to send: embedded images go first, then it's too big to show.
      if (html.length + prepared.css.length > MOCKUP_MAX_CHARS)
        html = html.replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, "");
      const limits = [...prepared.limits];
      if (html.length + prepared.css.length > MOCKUP_MAX_CHARS) {
        html = "";
        limits.push("too-big");
      }
      return {
        id: raw.id,
        title: raw.title,
        format: raw.format,
        revision: raw.revision,
        html,
        css: prepared.css,
        values: raw.values ?? {},
        frame: raw.frame ?? frameFor(raw),
        limits,
      };
    },
  );

  orca.panels.handle("answer", async (input: AnswerInput) => {
    const parts = [
      ...(input.answer ? [input.answer] : []),
      ...(input.options ?? []).flatMap((option) => ["--option", option]),
      ...(input.note ? ["--note", input.note] : []),
      ...(input.skipped ? ["--skip"] : []),
    ];
    if (input.ref.kind === "own")
      await runKim(runner, ["answer", input.ref.id, input.question, ...parts]);
    else
      await runKim(runner, [
        "draft",
        input.ref.id,
        input.question,
        ...parts,
        "--send",
      ]);
    return { ok: true as const };
  });

  orca.panels.handle("open", async ({ url, workspacePath }) => ({
    opened: await openInOrca(
      url,
      workspacePath ?? focusedWorkspace(workspaces, context)?.path ?? null,
    ),
  }));

  orca.panels.handle("agent.start", async ({ url, title }) => {
    const workspace = focusedWorkspace(workspaces, context);
    if (!workspace)
      return {
        started: false,
        reason: "Open the workspace the agent should work in first.",
      };
    const agent = (await setting("agent")) || "claude";
    try {
      await orca.host.call("agent.launch", {
        workspaceId: workspace.id,
        agent,
        prompt: `"${title}" was sent to me to answer: ${url}\nRead it with \`kim inbox show\`, then draft an answer to each question with \`kim draft\` (never --send). Leave questions only I can answer undrafted, and tell me when the drafts are ready to review.`,
      });
      return { started: true };
    } catch (error) {
      return {
        started: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  orca.log("Keep it moving is watching your interviews");
}

/** The mockup kit, read once from the plugin folder. */
async function loadKit(): Promise<Kit> {
  const { compileTailwind } = (await import(
    new URL("../vendor/tailwind.mjs", import.meta.url).href
  )) as {
    compileTailwind: Kit["compileTailwind"];
  };
  const lucide = JSON.parse(
    readFileSync(new URL("../vendor/lucide.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  return { compileTailwind, lucide };
}

/** A frame's size when kim doesn't say: as the web app sizes it. */
function frameFor(artifact: {
  title: string;
  description?: string | null;
  format: string;
}) {
  const words = `${artifact.title} ${artifact.description ?? ""}`;
  if (artifact.format !== "html") return { width: 620, height: null };
  if (/\b(mobile|phone)\b/i.test(words)) return { width: 390, height: 844 };
  if (/\b(tablet|ipad)\b/i.test(words)) return { width: 834, height: 1112 };
  return { width: 1280, height: 800 };
}
