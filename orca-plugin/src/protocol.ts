// What the worker and the panel say to each other, and what `kim` prints.

/** One of the user's own interviews, as `kim overview` lists it. */
export interface OwnInterview {
  id: string;
  token: string;
  title: string;
  status: "active" | "stopped";
  url: string;
  project: { id: string; name: string | null; color: string | null } | null;
  origin: {
    branch: string | null;
    worktree: string | null;
    agent: string | null;
    agentSession: string | null;
    location: "local" | "cloud" | null;
  };
  answered: number;
  total: number;
  /** Unanswered questions that wait on the user. */
  open: number;
  assignee: string | null;
  lastActivity: string;
  lastReply: { text: string; at: string } | null;
  awaitingReply: boolean;
  /** An agent is waiting on this interview's answers. */
  agentWatching: boolean;
}

/** An interview someone sent the user, as `kim overview` lists it. */
export interface SentInterview {
  /** Its token. */
  id: string;
  url: string;
  title: string;
  from: string | null;
  sentTo: string | null;
  status: "active" | "stopped";
  openQuestions: number;
  drafted: number;
}

export interface Overview {
  sessions: OwnInterview[];
  inbox: SentInterview[];
}

export interface Workspace {
  id: string;
  kind: "worktree" | "folder";
  name: string;
  path: string;
  branch: string | null;
}

/** Why the worker can't reach kim, for the panel to say what to do. */
export type KimProblem =
  | { kind: "missing" }
  | { kind: "signed-out" }
  | { kind: "failed"; message: string };

export interface PanelState {
  overview: Overview | null;
  problem: KimProblem | null;
  /** The workspace Orca shows, when the worker knows it. */
  workspace: Workspace | null;
  /** Ids of own interviews started in that workspace, most recent first. */
  here: string[];
}

export type InterviewRef =
  { kind: "own"; id: string } | { kind: "sent"; id: string };

export interface AnswerInput {
  ref: InterviewRef;
  question: string;
  options?: string[];
  answer?: string;
  note?: string;
  skipped?: boolean;
}

export interface MockupView {
  id: string;
  title: string;
  format: string;
  revision: number;
  /** The page, with Lucide icons drawn and images embedded. */
  html: string;
  /** Compiled Tailwind for it, or "". */
  css: string;
  /** Control → value its saved answers set. */
  values: Record<string, string>;
  frame: { width: number; height: number | null };
  limits: string[];
}

declare module "orca" {
  interface PluginRequests {
    "state.get": { output: PanelState };
    "interview.get": { input: InterviewRef; output: unknown };
    "artifact.get": {
      input: { ref: InterviewRef; artifactId: string };
      output: MockupView;
    };
    answer: { input: AnswerInput; output: { ok: true } };
    open: {
      input: {
        url: string;
        workspacePath?: string | null;
        /** Close the right sidebar after: the browser instead of the panel. */
        closePanel?: boolean;
      };
      output: { opened: boolean };
    };
    "agent.start": {
      input: { url: string; title: string };
      output: { started: boolean; reason?: string };
    };
  }
  interface PluginPanelEvents {
    "state.changed": PanelState;
  }
}
