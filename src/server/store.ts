import {
  AnswerInputSchema,
  ARTIFACT_MAX_BYTES,
  ArtifactInputSchema,
  ChatInputSchema,
  literalLineBreaks,
  ArtifactPatchSchema,
  FramePositionSchema,
  GrantSchema,
  normalizeDefault,
  QuestionInputSchema,
  QuestionPatchSchema,
  SealedAnswerInputSchema,
  SealedArtifactInputSchema,
  SealedArtifactPatchSchema,
  SealedChatInputSchema,
  SealedQuestionInputSchema,
  SealedQuestionPatchSchema,
  SealedSessionInputSchema,
  SessionInputSchema,
  UnlockSchema,
  type ArtifactFormat,
  type Grant,
  type ArtifactView,
  type ChatAuthor,
  type DesignType,
  type RepoOrigin,
  type ChatMessageView,
  type DraftView,
  type InterviewEvent,
  type FramePosition,
  type OriginView,
  type PinView,
  type ProjectView,
  type SessionSummary,
  type StageSource,
  type QuestionView,
  type SessionView,
} from "../shared/schema.js";
import { boundControls } from "../shared/bindings.js";
import { kidsIn, type PublicKey, type Unlock } from "../shared/crypto.js";
import {
  bindingWarnings,
  checkBinding,
  checkLinks,
  type ArtifactRef,
} from "../shared/questions.js";
import { projectName } from "../shared/remote.js";
import { artifactFormat } from "../shared/workspace.js";
import { framePage, type FrameParts } from "./framePage.js";
import { usesTokens } from "./tokensPage.js";
import { first, type Row, type Sql } from "./sql.js";

const now = () => new Date().toISOString();
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const optional = (value: unknown) => (value === null ? null : String(value));

/**
 * Project colours: dark enough for white text, and different in lightness as
 * well as hue so they stay distinguishable without colour vision.
 */
const PROJECT_COLORS = [
  "#0f6b62",
  "#7a2e8f",
  "#2550b8",
  "#b4520f",
  "#a3243b",
  "#3d6b1f",
  "#5b4bb7",
  "#00708a",
  "#8a6200",
  "#6b4a3a",
];

/** Push services browsers subscribe through: Chrome/Android, Firefox, Edge, Safari. */
const PUSH_SERVICES = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
];

const ORIGIN_COLUMNS = [
  "project_id",
  "branch",
  "worktree",
  "agent",
  "agent_session",
  "location",
] as const;

/**
 * Who an interview is assigned to (and who assigned it), and who wrote each
 * answer and chat message when it wasn't the owner.
 */
const ATTRIBUTION_COLUMNS = [
  ["sessions", "assignee"],
  ["sessions", "assigned_by"],
  ["answers", "answered_by"],
  ["chat_messages", "author_email"],
  // When an agent's hook last asked for answers, which keeps it live.
  ["sessions", "hook_seen_at"],
  // A design's type, the repo file an artifact came from (JSON), and
  // whether it is written back when the interview stops ("1").
  ["artifacts", "design_type"],
  ["artifacts", "repo"],
  ["artifacts", "keep"],
  // A question's controls in its artifact (optionValues, control, unit), as JSON.
  ["questions", "binding"],
  // A comment's pin on an artifact, as JSON.
  ["chat_messages", "pin"],
  // The last event the assignee's agent has been given (see inboxChanges);
  // null until it has seen the interview at all.
  ["sessions", "inbox_delivered"],
  // An end-to-end encrypted interview's key id; null for a plain one.
  ["sessions", "kid"],
  // How a sealed artifact renders, which the service can't tell from it.
  ["artifacts", "format"],
  // A sealed artifact's keyed hash, compared with its repo copy's.
  ["artifacts", "content_tag"],
] as const;

type Binding = Pick<QuestionView, "optionValues" | "control" | "unit">;

function readBinding(column: unknown): Binding {
  const stored = column ? json<Partial<Binding>>(column) : {};
  return {
    optionValues: stored.optionValues ?? {},
    control: stored.control ?? null,
    unit: stored.unit ?? null,
  };
}
const writeBinding = (binding: Binding) =>
  boundControls(binding).length ? JSON.stringify(binding) : null;

/** Just enough to catch a typo; Google checks the address at sign-in. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Caps on one workspace, so an open sign-up can't fill a Durable Object.
 * Deleted questions and artifacts still count: their rows remain.
 */
export const LIMITS = {
  interviews: 500,
  questions: 200,
  artifacts: 50,
  chatMessages: 2_000,
  /** The newest devices keep notifications; older ones drop off. */
  pushDevices: 20,
} as const;

/** The hub answers these with 403 and the message. */
export const LIMIT_REACHED = "Limit reached";

/** 192 random bits, URL-safe: the secret part of a session's browser URL. */
function sessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** What the assignee's agent hasn't been given yet; see inboxChanges. */
export interface InboxChanges {
  /** The agent hasn't seen this interview at all: read it whole. */
  assigned: boolean;
  questions: Array<{
    id: string;
    number: number;
    type: QuestionView["type"];
    prompt: string;
  }>;
  messages: Array<{
    id: string;
    text: string;
    replyTo: string | null;
    /** The question whose thread it replies in. */
    question: number | null;
  }>;
  artifacts: InboxArtifactChange[];
  notes: string[];
  status: SessionView["status"];
  through: number;
}
export interface InboxArtifactChange {
  id: string;
  title: string;
  kind: ArtifactView["kind"];
  happened: Array<"added" | "revised" | "removed" | "shown">;
  revision: number;
}

/** Whether there is anything in these changes for the agent. */
export const hasInboxNews = (changes: InboxChanges) =>
  changes.assigned ||
  changes.questions.length > 0 ||
  changes.messages.length > 0 ||
  changes.artifacts.length > 0;

export class InterviewStore {
  private readonly listeners = new Set<(event: InterviewEvent) => void>();

  constructor(private readonly sql: Sql) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Untitled interview', token TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', focused_question_id TEXT, focused_question_ids TEXT NOT NULL DEFAULT '[]',
        stage_artifact_id TEXT, stage_source TEXT,
        stage_visible INTEGER NOT NULL DEFAULT 0, stage_visibility_source TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        type TEXT NOT NULL, prompt TEXT NOT NULL, recommendation TEXT, default_answer TEXT,
        options TEXT NOT NULL DEFAULT '[]', artifact_id TEXT, option_artifacts TEXT NOT NULL DEFAULT '{}',
        min REAL, max REAL, step REAL, position INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS answers (
        question_id TEXT PRIMARY KEY,
        text TEXT NOT NULL, skipped INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0, event_id INTEGER, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        type TEXT NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, description TEXT, source TEXT,
        revision INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL,
        question_id TEXT, reply_to TEXT, delivered INTEGER NOT NULL DEFAULT 0, event_id INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frame_positions (
        session_id TEXT NOT NULL, artifact_id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY (session_id, artifact_id)
      );
      CREATE TABLE IF NOT EXISTS drafts (
        question_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        text TEXT NOT NULL, skipped INTEGER NOT NULL DEFAULT 0, drafted_by TEXT NOT NULL,
        artifact_revision INTEGER, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grants (
        session_id TEXT NOT NULL, fp TEXT NOT NULL, role TEXT NOT NULL, wrapped TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (session_id, fp)
      );
      CREATE TABLE IF NOT EXISTS account_key (
        id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, fp TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS unlocks (
        id TEXT PRIMARY KEY, method TEXT NOT NULL, credential_id TEXT, salt TEXT NOT NULL,
        wrapped TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS questions_session ON questions(session_id);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, delivered);
      CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(session_id);
      CREATE INDEX IF NOT EXISTS chat_session ON chat_messages(session_id, created_at);
    `);
    // Columns added after the first deploy; adding one that exists throws.
    for (const [table, column] of [
      ...ORIGIN_COLUMNS.map((column) => ["sessions", column] as const),
      ...ATTRIBUTION_COLUMNS,
    ])
      try {
        sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      } catch {
        /* already there */
      }
  }

  subscribe(listener: (event: InterviewEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createSession(baseUrl: string, input: unknown = {}): SessionView {
    const sealed =
      input && typeof input === "object" && "encryption" in input
        ? SealedSessionInputSchema.parse(input)
        : null;
    const { title, stageVisible, origin } =
      sealed ?? SessionInputSchema.parse(input);
    const kid = sealed?.encryption.kid ?? null;
    // Once an account encrypts, nothing plain gets in: an older client is told to update.
    if (!sealed && this.accountKey())
      throw new Error(
        "This account encrypts interviews end to end; update kim (`kim update`) and sign in again (`kim login`)",
      );
    if (kid && first(this.sql, "SELECT 1 FROM sessions WHERE kid = ?", kid))
      throw new Error("That interview key is already in use");
    if (sealed) sealedUnder(kid!, { title, origin });
    if (this.count("sessions") >= LIMITS.interviews)
      throw new Error(
        `${LIMIT_REACHED}: a workspace holds at most ${LIMITS.interviews} interviews; delete some (kim session delete --stopped) to make room`,
      );
    const id = crypto.randomUUID();
    const time = now();
    const projectId = this.resolveProject(origin);
    this.sql.all(
      `INSERT INTO sessions (id, title, token, stage_visible, stage_visibility_source, created_at, updated_at,
        project_id, branch, worktree, agent, agent_session, location, kid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      title,
      sessionToken(),
      stageVisible ? 1 : 0,
      stageVisible ? "agent" : null,
      time,
      time,
      projectId,
      origin.branch ?? null,
      origin.worktree ?? null,
      origin.agent ?? null,
      origin.agentSession ?? null,
      origin.location ?? null,
      kid,
    );
    if (sealed) this.addGrants(id, sealed.encryption.grants);
    this.emit(id, "session.created", { id });
    return this.getSession(id, baseUrl);
  }

  /**
   * The project an interview belongs to. A name the agent chose matches an
   * existing project; otherwise the detected key finds or creates one, so
   * every worktree and cloud session of a repo shares it.
   */
  private resolveProject(origin: {
    project?: string | undefined;
    projectKey?: string | undefined;
    projectName?: string | undefined;
  }): string | null {
    if (origin.project) {
      const found = first(
        this.sql,
        "SELECT id FROM projects WHERE lower(name) = lower(?) OR key = ?",
        origin.project,
        origin.project,
      );
      if (found) return String(found.id);
      return this.createProject(
        `name:${origin.project.toLowerCase()}`,
        origin.project,
      );
    }
    if (!origin.projectKey) return null;
    const found = first(
      this.sql,
      "SELECT id FROM projects WHERE key = ?",
      origin.projectKey,
    );
    if (found) return String(found.id);
    return this.createProject(
      origin.projectKey,
      origin.projectName ?? projectName(origin.projectKey),
    );
  }

  /** A new project takes the first colour no project has yet. */
  private createProject(key: string, name: string): string {
    const used = new Set(
      this.sql
        .all("SELECT color FROM projects")
        .map((row) => String(row.color)),
    );
    const count = this.sql.all("SELECT COUNT(*) n FROM projects")[0]!.n;
    const color =
      PROJECT_COLORS.find((candidate) => !used.has(candidate)) ??
      PROJECT_COLORS[Number(count) % PROJECT_COLORS.length]!;
    const id = crypto.randomUUID();
    this.sql.all(
      "INSERT INTO projects (id, key, name, color, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      key,
      name,
      color,
      now(),
    );
    return id;
  }

  listProjects(): ProjectView[] {
    return this.sql
      .all("SELECT * FROM projects ORDER BY lower(name)")
      .map(mapProject);
  }

  /** Every interview, most recently active first, for the switcher and home page. */
  summaries(): SessionSummary[] {
    return this.sql
      .all(
        `SELECT s.*, p.id p_id, p.key p_key, p.name p_name, p.color p_color,
          (SELECT COUNT(*) FROM questions q WHERE q.session_id = s.id AND q.deleted = 0) total,
          (SELECT COUNT(*) FROM questions q JOIN answers a ON a.question_id = q.id
            WHERE q.session_id = s.id AND q.deleted = 0) answered,
          (SELECT MAX(created_at) FROM events e WHERE e.session_id = s.id) last_event,
          (SELECT json_object('text', text, 'at', created_at) FROM chat_messages c
            WHERE c.session_id = s.id AND c.author = 'agent' ORDER BY created_at DESC, rowid DESC LIMIT 1) last_reply,
          (SELECT author FROM chat_messages c
            WHERE c.session_id = s.id ORDER BY created_at DESC, rowid DESC LIMIT 1) last_author,
          (SELECT json_group_array(fp) FROM grants g WHERE g.session_id = s.id) grant_fps
        FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
        ORDER BY COALESCE(last_event, s.updated_at) DESC LIMIT 200`,
      )
      .map((row) => {
        const total = Number(row.total);
        const answered = Number(row.answered);
        const status = row.status as SessionSummary["status"];
        return {
          id: String(row.id),
          token: String(row.token),
          kid: optional(row.kid),
          ...(row.kid ? { grants: json<string[]>(row.grant_fps ?? "[]") } : {}),
          title: String(row.title),
          status,
          project: row.p_id
            ? mapProject({
                id: row.p_id,
                key: row.p_key ?? null,
                name: row.p_name ?? null,
                color: row.p_color ?? null,
              })
            : null,
          origin: mapOrigin(row),
          answered,
          total,
          // An assigned interview waits on its assignee, not the owner.
          open: status === "active" && !row.assignee ? total - answered : 0,
          assignee: optional(row.assignee),
          lastActivity: String(row.last_event ?? row.updated_at),
          lastReply: row.last_reply
            ? json<{ text: string; at: string }>(row.last_reply)
            : null,
          awaitingReply: row.last_author === "user",
        };
      });
  }

  /** Unanswered questions in an active interview, or 0 when it is stopped. */
  openQuestions(sessionId: string): number {
    const row = first(
      this.sql,
      `SELECT s.status, s.assignee, (SELECT COUNT(*) FROM questions q LEFT JOIN answers a ON a.question_id = q.id
         WHERE q.session_id = s.id AND q.deleted = 0 AND a.question_id IS NULL) open
       FROM sessions s WHERE s.id = ?`,
      sessionId,
    );
    return row && row.status === "active" && !row.assignee
      ? Number(row.open)
      : 0;
  }

  /** An agent's hook asked this interview for answers just now. */
  touchHook(sessionId: string): void {
    this.sql.all(
      "UPDATE sessions SET hook_seen_at = ? WHERE id = ?",
      now(),
      sessionId,
    );
  }

  /**
   * Active interviews with questions still unanswered whose hook asked for
   * answers since `since`, whoever the questions wait on.
   */
  hookedSessions(since: string): string[] {
    return this.sql
      .all(
        `SELECT s.id FROM sessions s WHERE s.status = 'active' AND s.hook_seen_at >= ?
           AND EXISTS (SELECT 1 FROM questions q LEFT JOIN answers a ON a.question_id = q.id
             WHERE q.session_id = s.id AND q.deleted = 0 AND a.question_id IS NULL)`,
        since,
      )
      .map((row) => String(row.id));
  }

  /** Push endpoints of the user's devices; pushes carry no data. */
  pushSubscriptions(): string[] {
    return this.sql
      .all("SELECT endpoint FROM push_subscriptions")
      .map((row) => String(row.endpoint));
  }

  /** Only real push services, so the Worker never POSTs to an arbitrary URL. */
  addPushSubscription(endpoint: string): void {
    let host: string;
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:") throw new Error();
      host = url.hostname;
    } catch {
      throw new Error("A push endpoint is an https URL");
    }
    if (endpoint.length > 2_000)
      throw new Error("That push endpoint is too long");
    if (
      !PUSH_SERVICES.some(
        (service) => host === service || host.endsWith(`.${service}`),
      )
    )
      throw new Error(`${host} is not a known push service`);
    this.sql.all(
      "INSERT INTO push_subscriptions (endpoint, created_at) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET created_at=excluded.created_at",
      endpoint,
      now(),
    );
    // Each test or notification pushes to every device, so keep them few.
    this.sql.all(
      `DELETE FROM push_subscriptions WHERE endpoint NOT IN
        (SELECT endpoint FROM push_subscriptions ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      LIMITS.pushDevices,
    );
  }

  removePushSubscription(endpoint: string): void {
    this.sql.all("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
  }

  listSessions(baseUrl: string, all = false): SessionView[] {
    return this.sql
      .all(
        `SELECT id FROM sessions ${all ? "" : "WHERE status = 'active'"} ORDER BY created_at DESC`,
      )
      .map((row) => this.getSession(String(row.id), baseUrl));
  }

  hasSession(id: string): boolean {
    return Boolean(first(this.sql, "SELECT 1 FROM sessions WHERE id=?", id));
  }

  sessionIdForToken(token: string): string | null {
    const row = first(
      this.sql,
      "SELECT id FROM sessions WHERE token = ?",
      token,
    );
    return row ? String(row.id) : null;
  }

  getSession(id: string, baseUrl: string): SessionView {
    const session = first(this.sql, "SELECT * FROM sessions WHERE id = ?", id);
    if (!session) throw new Error("Session not found");
    const questions = this.sql.all(
      `SELECT q.*, a.text answer_text, a.skipped, a.revision, a.delivered, a.updated_at answer_updated_at,
        a.answered_by
      FROM questions q LEFT JOIN answers a ON a.question_id = q.id
      WHERE q.session_id = ? AND q.deleted = 0 ORDER BY q.position, q.created_at`,
      id,
    );
    const artifacts = this.sql.all(
      "SELECT * FROM artifacts WHERE session_id = ? AND deleted = 0 ORDER BY kind = 'plan' DESC, created_at, rowid",
      id,
    );
    const kid = optional(session.kid);
    return {
      id: String(session.id),
      title: String(session.title),
      token: String(session.token),
      kid,
      ...(kid ? this.grantSummary(id) : {}),
      status: session.status as "active" | "stopped",
      url: `${baseUrl}/s/${String(session.token)}`,
      createdAt: String(session.created_at),
      updatedAt: String(session.updated_at),
      focusedQuestionId: optional(session.focused_question_id),
      focusedQuestionIds: json<string[]>(session.focused_question_ids),
      questions: questions.map((row): QuestionView => ({
        id: String(row.id),
        type: row.type as QuestionView["type"],
        prompt: String(row.prompt),
        recommendation: optional(row.recommendation),
        default:
          row.default_answer === null
            ? null
            : json<string[]>(row.default_answer),
        options: json<string[]>(row.options),
        min: row.min === null ? null : Number(row.min),
        max: row.max === null ? null : Number(row.max),
        step: row.step === null ? null : Number(row.step),
        position: Number(row.position),
        artifactId: optional(row.artifact_id),
        optionArtifacts: json<Record<string, string>>(row.option_artifacts),
        ...readBinding(row.binding),
        answer:
          row.revision === null
            ? null
            : {
                text: String(row.answer_text),
                skipped: Boolean(row.skipped),
                revision: Number(row.revision),
                delivered: Boolean(row.delivered),
                updatedAt: String(row.answer_updated_at),
                answeredBy: optional(row.answered_by),
              },
      })),
      artifacts: this.withTokensRevision(id, artifacts.map(this.mapArtifact)),
      positions: this.positions(id, new Set(artifacts.map((row) => row.id))),
      stage: session.stage_artifact_id
        ? {
            artifactId: String(session.stage_artifact_id),
            source: String(session.stage_source) as StageSource,
          }
        : null,
      stageVisible: Boolean(session.stage_visible),
      stageVisibilitySource: optional(
        session.stage_visibility_source,
      ) as StageSource | null,
      project: this.projectFor(session.project_id),
      origin: mapOrigin(session),
      chat: this.chat(id),
      assignee: optional(session.assignee),
      assignedBy: optional(session.assigned_by),
    };
  }

  /** Where the user put frames, for artifacts that are still there. */
  private positions(
    sessionId: string,
    live: Set<unknown>,
  ): Record<string, FramePosition> {
    return Object.fromEntries(
      this.sql
        .all(
          "SELECT artifact_id, x, y FROM frame_positions WHERE session_id = ?",
          sessionId,
        )
        .filter((row) => live.has(row.artifact_id))
        .map((row) => [
          String(row.artifact_id),
          { x: Number(row.x), y: Number(row.y) },
        ]),
    );
  }

  /** Puts an artifact's frame where the user dragged it, for everyone. */
  moveFrame(sessionId: string, artifactId: string, input: unknown): void {
    this.requireSession(sessionId);
    if (!this.liveArtifact(sessionId, artifactId))
      throw new Error("Artifact not found");
    const { x, y } = FramePositionSchema.parse(input);
    this.sql.all(
      `INSERT INTO frame_positions (session_id, artifact_id, x, y, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (session_id, artifact_id) DO UPDATE SET x=excluded.x, y=excluded.y, updated_at=excluded.updated_at`,
      sessionId,
      artifactId,
      Math.round(x),
      Math.round(y),
      now(),
    );
  }

  /** The interview's chat thread, oldest first. */
  chat(sessionId: string): ChatMessageView[] {
    return this.sql
      .all(
        "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at, rowid",
        sessionId,
      )
      .map((row) => ({
        id: String(row.id),
        author: row.author as ChatAuthor,
        text: String(row.text),
        questionId: optional(row.question_id),
        replyTo: optional(row.reply_to),
        delivered: Boolean(row.delivered),
        createdAt: String(row.created_at),
        authorEmail: optional(row.author_email),
        pin: row.pin ? json<PinView>(row.pin) : null,
      }));
  }

  /**
   * Adds a message to the chat. The user's are about the interview or one
   * question and reach the agent the way answers do; the agent's reply.
   */
  addChatMessage(
    sessionId: string,
    author: ChatAuthor,
    input: unknown,
    /** The assignee who wrote it; null for the owner and the agent. */
    by: string | null = null,
  ): ChatMessageView {
    this.requireActive(sessionId);
    const kid = this.kidOf(sessionId);
    const parsed = kid
      ? sealedUnder(kid, SealedChatInputSchema.parse(input))
      : ChatInputSchema.parse(input);
    // The agent's text often comes through a shell; the user's is as typed.
    // A sealed message had this done before it was sealed.
    if (author === "agent" && !kid)
      parsed.text = literalLineBreaks(parsed.text);
    if (this.count("chat_messages", sessionId) >= LIMITS.chatMessages)
      throw new Error(
        `${LIMIT_REACHED}: an interview's chat holds at most ${LIMITS.chatMessages} messages; start a new interview`,
      );
    const questionId = author === "user" ? (parsed.questionId ?? null) : null;
    const replyTo = author === "agent" ? (parsed.replyTo ?? null) : null;
    if (questionId) this.questionRow(sessionId, questionId);
    const placed = author === "user" ? (parsed.pin ?? null) : null;
    if (placed && !this.liveArtifact(sessionId, placed.artifactId))
      throw new Error(`No artifact ${placed.artifactId} in this session`);
    // Numbered in the order they're sent, so "pin 3" means the same to everyone.
    const pin: PinView | null = placed && {
      n:
        Number(
          first(
            this.sql,
            "SELECT COUNT(*) n FROM chat_messages WHERE session_id = ? AND pin IS NOT NULL",
            sessionId,
          )?.n ?? 0,
        ) + 1,
      ...placed,
    };
    if (
      replyTo &&
      !first(
        this.sql,
        "SELECT 1 FROM chat_messages WHERE id = ? AND session_id = ?",
        replyTo,
        sessionId,
      )
    )
      throw new Error(`No chat message ${replyTo} in this session`);
    const id = crypto.randomUUID();
    const event = this.emit(
      sessionId,
      author === "user" ? "chat.message" : "chat.reply",
      {
        messageId: id,
        text: parsed.text,
        ...(questionId ? { questionId } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(by ? { by } : {}),
        ...(pin ? { pin } : {}),
      },
    );
    // Only the user's messages wait to be delivered; the agent wrote its own.
    this.sql.all(
      `INSERT INTO chat_messages (id, session_id, author, text, question_id, reply_to, delivered, event_id, created_at, author_email, pin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sessionId,
      author,
      parsed.text,
      questionId,
      replyTo,
      author === "agent" ? 1 : 0,
      event.id,
      event.createdAt,
      by,
      pin && JSON.stringify(pin),
    );
    return this.chat(sessionId).find((message) => message.id === id)!;
  }

  private projectFor(projectId: unknown): ProjectView | null {
    if (!projectId) return null;
    const row = first(
      this.sql,
      "SELECT * FROM projects WHERE id = ?",
      String(projectId),
    );
    return row ? mapProject(row) : null;
  }

  setSessionStatus(id: string, status: "active" | "stopped"): void {
    this.requireSession(id);
    this.sql.all(
      "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
      status,
      now(),
      id,
    );
    this.emit(
      id,
      status === "active" ? "session.resumed" : "session.stopped",
      {},
    );
  }

  deleteSession(id: string): void {
    this.requireSession(id);
    this.sql.transaction(() => {
      this.sql.all(
        "DELETE FROM answers WHERE question_id IN (SELECT id FROM questions WHERE session_id = ?)",
        id,
      );
      for (const table of [
        "drafts",
        "grants",
        "questions",
        "events",
        "artifacts",
        "chat_messages",
        "frame_positions",
      ])
        this.sql.all(`DELETE FROM ${table} WHERE session_id = ?`, id);
      this.sql.all("DELETE FROM sessions WHERE id = ?", id);
    });
  }

  /**
   * Assigns the interview to someone else to answer, or clears it with
   * null. One assignee at a time; returns the one it replaced.
   */
  assignSession(
    id: string,
    email: string | null,
    by: string | null,
  ): { assignee: string | null; previous: string | null } {
    const row = first(
      this.sql,
      "SELECT assignee FROM sessions WHERE id = ?",
      id,
    );
    if (!row) throw new Error("Session not found");
    const assignee = email?.trim().toLowerCase() || null;
    if (assignee && !EMAIL.test(assignee))
      throw new Error(`"${email}" is not an email address`);
    // A new assignee starts afresh: nothing seen, nothing drafted.
    if (assignee !== optional(row.assignee)) {
      this.sql.all(
        "UPDATE sessions SET inbox_delivered = NULL WHERE id = ?",
        id,
      );
      this.sql.all("DELETE FROM drafts WHERE session_id = ?", id);
      // The old assignee's key no longer opens it; the new one's is added
      // by the owner's client, which holds the interview key.
      this.sql.all(
        "DELETE FROM grants WHERE session_id = ? AND role = 'assignee'",
        id,
      );
    }
    this.sql.all(
      "UPDATE sessions SET assignee = ?, assigned_by = ?, updated_at = ? WHERE id = ?",
      assignee,
      assignee ? by : null,
      now(),
      id,
    );
    this.emit(id, "session.assigned", { assignee });
    return { assignee, previous: optional(row.assignee) };
  }

  /** Who the interview with this browser token is assigned to, if anyone. */
  assigneeForToken(token: string): string | null {
    const row = first(
      this.sql,
      "SELECT assignee FROM sessions WHERE token = ?",
      token,
    );
    return row ? optional(row.assignee) : null;
  }

  addQuestions(sessionId: string, inputs: unknown[]): QuestionView[] {
    this.requireActive(sessionId);
    const kid = this.kidOf(sessionId);
    const parsed = inputs.map((item) => {
      // A sealed question was checked and normalised by the client.
      const input = kid
        ? sealedUnder(kid, SealedQuestionInputSchema.parse(item))
        : QuestionInputSchema.parse(item);
      this.validateLinks(
        sessionId,
        input.artifactId ?? null,
        input.optionArtifacts ?? {},
        input.options,
        Boolean(kid),
      );
      const binding = {
        optionValues: input.optionValues ?? {},
        control: input.control ?? null,
        unit: input.unit ?? null,
      };
      this.validateBinding(
        sessionId,
        { ...input, ...binding, artifactId: input.artifactId ?? null },
        Boolean(kid),
      );
      return {
        ...input,
        binding,
        default: kid
          ? (input.default ?? null)
          : normalizeDefault(input.type, input.options, input.default ?? null),
      };
    });
    if (this.count("questions", sessionId) + parsed.length > LIMITS.questions)
      throw new Error(
        `${LIMIT_REACHED}: an interview holds at most ${LIMITS.questions} questions; start a new interview`,
      );
    const maxRow = first(
      this.sql,
      "SELECT COALESCE(MAX(position), -1) max FROM questions WHERE session_id = ? AND deleted = 0",
      sessionId,
    )!;
    let next = Number(maxRow.max) + 1;
    const created = this.sql.transaction(() =>
      parsed.map((input) => {
        const id = crypto.randomUUID();
        const time = now();
        this.sql.all(
          `INSERT INTO questions (id, session_id, type, prompt, recommendation, default_answer, options, artifact_id, option_artifacts, binding, min, max, step, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          sessionId,
          input.type,
          input.prompt,
          input.recommendation ?? null,
          input.default ? JSON.stringify(input.default) : null,
          JSON.stringify(input.options),
          input.artifactId ?? null,
          JSON.stringify(input.optionArtifacts ?? {}),
          writeBinding(input.binding),
          input.min ?? null,
          input.max ?? null,
          input.step ?? null,
          input.position ?? next++,
          time,
          time,
        );
        return id;
      }),
    );
    for (const id of created)
      this.emit(sessionId, "question.added", { questionId: id });
    const view = this.getSession(sessionId, "").questions;
    return view.filter((question) => created.includes(question.id));
  }

  updateQuestion(
    sessionId: string,
    questionId: string,
    patch: unknown,
  ): QuestionView {
    this.requireActive(sessionId);
    const current = this.questionRow(sessionId, questionId);
    const kid = this.kidOf(sessionId);
    const parsed = kid
      ? sealedUnder(kid, SealedQuestionPatchSchema.parse(patch))
      : QuestionPatchSchema.parse(patch);
    // An omitted field keeps the stored value; an explicit null clears it.
    const keep = <T>(
      value: T | null | undefined,
      column: unknown,
      read: (stored: string) => T,
    ): T | null =>
      value === undefined
        ? column === null
          ? null
          : read(String(column))
        : value;
    const type = parsed.type ?? (String(current.type) as QuestionView["type"]);
    const options = parsed.options ?? json<string[]>(current.options);
    const kept = keep(parsed.default, current.default_answer, (v) =>
      json<string[]>(v),
    );
    const defaultAnswer = kid ? kept : normalizeDefault(type, options, kept);
    // Options may have been renamed; links to vanished labels are dropped.
    // Sealed labels can't be compared: the client sends them whole.
    const labelled = (label: string) => Boolean(kid) || options.includes(label);
    const optionArtifacts = Object.fromEntries(
      Object.entries(
        parsed.optionArtifacts ??
          json<Record<string, string>>(current.option_artifacts),
      ).filter(([label]) => labelled(label)),
    );
    const artifactId = keep<string>(
      parsed.artifactId,
      current.artifact_id,
      String,
    );
    this.validateLinks(
      sessionId,
      artifactId,
      optionArtifacts,
      options,
      Boolean(kid),
    );
    const stored = readBinding(current.binding);
    const binding = {
      optionValues: Object.fromEntries(
        Object.entries(parsed.optionValues ?? stored.optionValues).filter(
          ([label]) => labelled(label),
        ),
      ),
      control: parsed.control === undefined ? stored.control : parsed.control,
      unit: parsed.unit === undefined ? stored.unit : parsed.unit,
    };
    const min = keep(parsed.min, current.min, Number);
    const max = keep(parsed.max, current.max, Number);
    this.validateBinding(
      sessionId,
      { type, options, artifactId, min, max, ...binding },
      Boolean(kid),
    );
    this.sql.all(
      `UPDATE questions SET type=?, prompt=?, recommendation=?, default_answer=?, options=?, artifact_id=?, option_artifacts=?, binding=?, min=?, max=?, step=?, position=?, updated_at=? WHERE id=?`,
      type,
      parsed.prompt ?? String(current.prompt),
      keep(parsed.recommendation, current.recommendation, String),
      defaultAnswer ? JSON.stringify(defaultAnswer) : null,
      JSON.stringify(options),
      artifactId,
      JSON.stringify(optionArtifacts),
      writeBinding(binding),
      min,
      max,
      keep(parsed.step, current.step, Number),
      parsed.position ?? Number(current.position),
      now(),
      questionId,
    );
    this.emit(sessionId, "question.updated", { questionId });
    return this.getSession(sessionId, "").questions.find(
      (q) => q.id === questionId,
    )!;
  }

  deleteQuestion(sessionId: string, questionId: string): void {
    this.requireActive(sessionId);
    this.questionRow(sessionId, questionId);
    this.sql.all(
      "UPDATE questions SET deleted=1, updated_at=? WHERE id=?",
      now(),
      questionId,
    );
    const focus = this.getSession(sessionId, "");
    if (focus.focusedQuestionIds.includes(questionId))
      this.writeFocus(
        sessionId,
        focus.focusedQuestionIds.filter((id) => id !== questionId),
      );
    this.emit(sessionId, "question.deleted", { questionId });
  }

  /** Focuses a group of questions the agent wants answered next. */
  focusQuestions(sessionId: string, questionIds: string[]): void {
    this.requireActive(sessionId);
    const ids = [...new Set(questionIds)];
    for (const id of ids) this.questionRow(sessionId, id);
    this.writeFocus(sessionId, ids);
    this.emit(sessionId, "question.focused", {
      questionId: ids[0] ?? null,
      questionIds: ids,
    });
    // A question about an artifact brings it on screen.
    const lead = ids[0] ? this.questionRow(sessionId, ids[0]) : null;
    const artifactId = lead?.artifact_id ? String(lead.artifact_id) : null;
    const staged = first(
      this.sql,
      "SELECT stage_artifact_id FROM sessions WHERE id=?",
      sessionId,
    )!;
    if (
      artifactId &&
      artifactId !== staged.stage_artifact_id &&
      this.liveArtifact(sessionId, artifactId)
    )
      this.showArtifact(sessionId, artifactId, "agent");
  }

  private writeFocus(sessionId: string, ids: string[]): void {
    this.sql.all(
      "UPDATE sessions SET focused_question_id=?, focused_question_ids=?, updated_at=? WHERE id=?",
      ids[0] ?? null,
      JSON.stringify(ids),
      now(),
      sessionId,
    );
  }

  answerQuestion(
    sessionId: string,
    questionId: string,
    input: unknown,
    /** The assignee who answered; null for the owner. */
    by: string | null = null,
  ): { revision: number; event: InterviewEvent } {
    this.requireActive(sessionId);
    this.questionRow(sessionId, questionId);
    const kid = this.kidOf(sessionId);
    const parsed = kid
      ? sealedUnder(kid, SealedAnswerInputSchema.parse(input))
      : AnswerInputSchema.parse(input);
    const previous = first(
      this.sql,
      "SELECT revision FROM answers WHERE question_id=?",
      questionId,
    );
    const revision = (previous ? Number(previous.revision) : 0) + 1;
    const event = this.emit(
      sessionId,
      previous ? "answer.revised" : "answer.submitted",
      {
        questionId,
        answer: parsed.answer,
        skipped: parsed.skipped,
        revision,
        ...(by ? { by } : {}),
      },
    );
    this.sql.all(
      `INSERT INTO answers (question_id,text,skipped,revision,delivered,event_id,updated_at,answered_by) VALUES (?,?,?,?,0,?,?,?)
      ON CONFLICT(question_id) DO UPDATE SET text=excluded.text, skipped=excluded.skipped, revision=excluded.revision, delivered=0, event_id=excluded.event_id, updated_at=excluded.updated_at, answered_by=excluded.answered_by`,
      questionId,
      parsed.answer,
      parsed.skipped ? 1 : 0,
      revision,
      event.id,
      now(),
      by,
    );
    // An answer, however it came, replaces the draft.
    this.sql.all("DELETE FROM drafts WHERE question_id = ?", questionId);
    return { revision, event };
  }

  /** The assignee's agent's drafts, by question, for questions still open. */
  drafts(sessionId: string): Record<string, DraftView> {
    return Object.fromEntries(
      this.sql
        .all(
          `SELECT d.* FROM drafts d JOIN questions q ON q.id = d.question_id
           LEFT JOIN answers a ON a.question_id = d.question_id
           WHERE d.session_id = ? AND q.deleted = 0 AND a.question_id IS NULL`,
          sessionId,
        )
        .map((row) => [
          String(row.question_id),
          {
            text: String(row.text),
            skipped: Boolean(row.skipped),
            draftedBy: String(row.drafted_by),
            updatedAt: String(row.updated_at),
            artifactRevision:
              row.artifact_revision === null
                ? null
                : Number(row.artifact_revision),
          },
        ]),
    );
  }

  /**
   * Saves a draft answer from the assignee's agent. No event: the owner's
   * agent and pages never learn of it, and it reaches them only when the
   * assignee sends it, as their own answer.
   */
  saveDraft(
    sessionId: string,
    questionId: string,
    answer: { answer: string; skipped: boolean },
    by: string,
  ): DraftView {
    this.requireActive(sessionId);
    const question = this.questionRow(sessionId, questionId);
    const kid = this.kidOf(sessionId);
    if (kid) sealedUnder(kid, SealedAnswerInputSchema.parse(answer));
    if (
      first(this.sql, "SELECT 1 FROM answers WHERE question_id=?", questionId)
    )
      throw new Error(
        "That question is already answered; drafts are for open questions",
      );
    const artifact = question.artifact_id
      ? this.liveArtifact(sessionId, String(question.artifact_id))
      : undefined;
    this.sql.all(
      `INSERT INTO drafts (question_id, session_id, text, skipped, drafted_by, artifact_revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(question_id) DO UPDATE SET text=excluded.text, skipped=excluded.skipped,
         drafted_by=excluded.drafted_by, artifact_revision=excluded.artifact_revision, updated_at=excluded.updated_at`,
      questionId,
      sessionId,
      answer.answer,
      answer.skipped ? 1 : 0,
      by.toLowerCase(),
      artifact ? Number(artifact.revision) : null,
      now(),
    );
    return this.drafts(sessionId)[questionId]!;
  }

  /** Drops a question's draft; false when it had none. */
  clearDraft(sessionId: string, questionId: string): boolean {
    this.questionRow(sessionId, questionId);
    const had = Boolean(
      first(this.sql, "SELECT 1 FROM drafts WHERE question_id=?", questionId),
    );
    this.sql.all("DELETE FROM drafts WHERE question_id = ?", questionId);
    return had;
  }

  /** Who an interview is assigned to, and its token, for telling their agent. */
  assignment(sessionId: string): { assignee: string; token: string } | null {
    const row = first(
      this.sql,
      "SELECT assignee, token FROM sessions WHERE id = ?",
      sessionId,
    );
    return row?.assignee
      ? { assignee: String(row.assignee), token: String(row.token) }
      : null;
  }

  /**
   * What the assignee's agent hasn't been given yet: whether the interview
   * is new to it, questions added, the owner's agent's chat replies, and
   * workspace changes, one entry per artifact however many edits it had,
   * with a note for each draft written against an older revision of an
   * artifact that changed. `through` is the event to mark delivered up to.
   */
  inboxChanges(sessionId: string): InboxChanges {
    const session = first(
      this.sql,
      "SELECT inbox_delivered, status FROM sessions WHERE id = ?",
      sessionId,
    );
    if (!session) throw new Error("Session not found");
    const cursor =
      session.inbox_delivered === null ? null : Number(session.inbox_delivered);
    const through = Number(
      first(
        this.sql,
        "SELECT COALESCE(MAX(id), 0) id FROM events WHERE session_id = ?",
        sessionId,
      )!.id,
    );
    const view = this.getSession(sessionId, "");
    const numbers = new Map(
      view.questions.map((question, index) => [question.id, index + 1]),
    );
    const changes: InboxChanges = {
      assigned: cursor === null,
      questions: [],
      messages: [],
      artifacts: [],
      notes: [],
      status: view.status,
      through,
    };
    // An interview new to the agent is news in itself: it reads it whole.
    if (cursor === null) return changes;
    const events = this.sql
      .all(
        `SELECT * FROM events WHERE session_id = ? AND id > ? AND type IN
          ('question.added', 'chat.reply', 'artifact.added', 'artifact.updated', 'artifact.deleted', 'stage.changed')
         ORDER BY id`,
        sessionId,
        cursor,
      )
      .map(this.mapEvent);
    const artifacts = new Map<string, InboxArtifactChange["happened"]>();
    for (const event of events) {
      const { payload } = event;
      if (event.type === "question.added") {
        const question = view.questions.find(
          (item) => item.id === payload.questionId,
        );
        if (question && !question.answer)
          changes.questions.push({
            id: question.id,
            number: numbers.get(question.id)!,
            type: question.type,
            prompt: question.prompt,
          });
        continue;
      }
      if (event.type === "chat.reply") {
        const message = view.chat.find((item) => item.id === payload.messageId);
        if (!message) continue;
        const about = view.chat.find(
          (item) => item.id === message.replyTo,
        )?.questionId;
        changes.messages.push({
          id: message.id,
          text: message.text,
          replyTo: message.replyTo,
          question: about ? (numbers.get(about) ?? null) : null,
        });
        continue;
      }
      if (event.type === "stage.changed" && payload.source !== "agent")
        continue;
      const artifactId = payload.artifactId ? String(payload.artifactId) : null;
      if (!artifactId) continue;
      const happened: InboxArtifactChange["happened"][number] =
        event.type === "artifact.added"
          ? "added"
          : event.type === "artifact.updated"
            ? "revised"
            : event.type === "artifact.deleted"
              ? "removed"
              : "shown";
      const happenings = artifacts.get(artifactId) ?? [];
      if (!happenings.includes(happened)) happenings.push(happened);
      artifacts.set(artifactId, happenings);
    }
    for (const [id, happened] of artifacts) {
      const row = first(
        this.sql,
        "SELECT * FROM artifacts WHERE id = ? AND session_id = ?",
        id,
        sessionId,
      );
      if (!row) continue;
      const removed = Boolean(row.deleted);
      changes.artifacts.push({
        id,
        title: String(row.title),
        kind: row.kind as ArtifactView["kind"],
        happened: removed ? ["removed"] : happened,
        revision: Number(row.revision),
      });
    }
    // A draft about an artifact that has moved on since it was written.
    const drafts = this.drafts(sessionId);
    for (const question of view.questions) {
      const draft = drafts[question.id];
      const changed = changes.artifacts.find(
        (item) => item.id === question.artifactId,
      );
      if (!draft || !changed || draft.artifactRevision === null) continue;
      if (changed.happened.includes("removed"))
        changes.notes.push(
          `Your draft for Q${numbers.get(question.id)} was written against ${changed.title}, which has been removed`,
        );
      else if (changed.revision > draft.artifactRevision)
        changes.notes.push(
          `Your draft for Q${numbers.get(question.id)} was written against an older ${changed.title} (revision ${draft.artifactRevision}; it is now ${changed.revision})`,
        );
    }
    return changes;
  }

  /** The assignee's agent has been given everything up to this event. */
  markInboxDelivered(sessionId: string, through: number): void {
    this.sql.all(
      "UPDATE sessions SET inbox_delivered = ? WHERE id = ?",
      String(through),
      sessionId,
    );
  }

  /** Adds an artifact. A session has one plan, so adding another plan replaces its content. */
  addArtifact(sessionId: string, input: unknown): ArtifactView {
    this.requireActive(sessionId);
    const kid = this.kidOf(sessionId);
    const parsed: { format?: ArtifactFormat; contentTag?: string } & ReturnType<
      typeof ArtifactInputSchema.parse
    > = kid
      ? sealedUnder(kid, SealedArtifactInputSchema.parse(input))
      : ArtifactInputSchema.parse(input);
    if (parsed.kind === "plan") {
      const plan = first(
        this.sql,
        "SELECT id FROM artifacts WHERE session_id=? AND kind='plan' AND deleted=0",
        sessionId,
      );
      if (plan)
        return this.updateArtifact(sessionId, String(plan.id), {
          title: parsed.title,
          content: parsed.content,
          ...(parsed.description !== undefined
            ? { description: parsed.description }
            : {}),
          ...(parsed.source !== undefined ? { source: parsed.source } : {}),
          ...(parsed.format ? { format: parsed.format } : {}),
          show: parsed.show,
        });
    }
    fitsInRow(parsed.content, parsed.source, parsed.repo);
    if (this.count("artifacts", sessionId) >= LIMITS.artifacts)
      throw new Error(
        `${LIMIT_REACHED}: an interview holds at most ${LIMITS.artifacts} artifacts; update one instead, or start a new interview`,
      );
    const id = crypto.randomUUID();
    const time = now();
    this.sql.all(
      "INSERT INTO artifacts (id,session_id,kind,title,content,description,source,design_type,repo,keep,created_at,updated_at,format,content_tag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      sessionId,
      parsed.kind,
      parsed.title,
      parsed.content,
      parsed.description ?? null,
      parsed.source ?? null,
      parsed.designType ?? null,
      parsed.repo ? JSON.stringify(parsed.repo) : null,
      parsed.keep ? "1" : null,
      time,
      time,
      parsed.format ?? null,
      parsed.contentTag ?? null,
    );
    this.emit(sessionId, "artifact.added", {
      artifactId: id,
      kind: parsed.kind,
      title: parsed.title,
    });
    if (parsed.show) this.showArtifact(sessionId, id, "agent");
    return this.artifactView(sessionId, id);
  }

  updateArtifact(
    sessionId: string,
    artifactId: string,
    patch: unknown,
  ): ArtifactView {
    this.requireActive(sessionId);
    const current = this.liveArtifact(sessionId, artifactId);
    if (!current) throw new Error("Artifact not found");
    const kid = this.kidOf(sessionId);
    const parsed: { format?: ArtifactFormat; contentTag?: string } & ReturnType<
      typeof ArtifactPatchSchema.parse
    > = kid
      ? sealedUnder(kid, SealedArtifactPatchSchema.parse(patch))
      : ArtifactPatchSchema.parse(patch);
    const changed =
      parsed.title !== undefined ||
      parsed.content !== undefined ||
      parsed.description !== undefined ||
      parsed.source !== undefined ||
      parsed.repo !== undefined;
    if (parsed.keep !== undefined && parsed.keep !== (current.keep === "1")) {
      // A badge, not a new version: the frame doesn't reload for it.
      this.sql.all(
        "UPDATE artifacts SET keep=?, updated_at=? WHERE id=?",
        parsed.keep ? "1" : null,
        now(),
        artifactId,
      );
      this.emit(sessionId, "artifact.kept", { artifactId, keep: parsed.keep });
    }
    if (changed) {
      const repo = parsed.repo === undefined ? repoOf(current) : parsed.repo;
      fitsInRow(
        parsed.content ?? String(current.content),
        parsed.source === undefined ? optional(current.source) : parsed.source,
        repo,
      );
      this.sql.all(
        "UPDATE artifacts SET title=?, content=?, description=?, source=?, repo=?, format=?, content_tag=?, revision=revision+1, updated_at=? WHERE id=?",
        parsed.title ?? String(current.title),
        parsed.content ?? String(current.content),
        parsed.description === undefined
          ? optional(current.description)
          : parsed.description,
        parsed.source === undefined ? optional(current.source) : parsed.source,
        repo ? JSON.stringify(repo) : null,
        parsed.format ?? optional(current.format),
        parsed.contentTag ??
          (parsed.content === undefined ? optional(current.content_tag) : null),
        now(),
        artifactId,
      );
      this.emit(sessionId, "artifact.updated", {
        artifactId,
        revision: Number(current.revision) + 1,
      });
    }
    if (parsed.show) this.showArtifact(sessionId, artifactId, "agent");
    // The client warns for a sealed artifact: only it can read the markup.
    const warnings =
      parsed.content === undefined || kid
        ? []
        : this.bindingWarnings(sessionId, artifactId);
    return {
      ...this.artifactView(sessionId, artifactId),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  deleteArtifact(sessionId: string, artifactId: string): void {
    this.requireActive(sessionId);
    if (!this.liveArtifact(sessionId, artifactId))
      throw new Error("Artifact not found");
    this.sql.all(
      "UPDATE artifacts SET deleted=1, updated_at=? WHERE id=?",
      now(),
      artifactId,
    );
    this.sql.all(
      "UPDATE sessions SET stage_artifact_id=NULL, stage_source=NULL WHERE id=? AND stage_artifact_id=?",
      sessionId,
      artifactId,
    );
    this.emit(sessionId, "artifact.deleted", { artifactId });
  }

  /** Puts an artifact on screen for everyone; null returns to the default. */
  showArtifact(
    sessionId: string,
    artifactId: string | null,
    source: StageSource,
  ): void {
    this.requireActive(sessionId);
    if (artifactId && !this.liveArtifact(sessionId, artifactId))
      throw new Error("Artifact not found");
    this.sql.all(
      "UPDATE sessions SET stage_artifact_id=?, stage_source=?, updated_at=? WHERE id=?",
      artifactId,
      artifactId ? source : null,
      now(),
      sessionId,
    );
    this.emit(sessionId, "stage.changed", { artifactId, source });
  }

  /** Opens or closes the workspace column; stopped sessions can still be rearranged. */
  setStageVisible(
    sessionId: string,
    visible: boolean,
    source: StageSource,
  ): void {
    this.requireSession(sessionId);
    this.sql.all(
      "UPDATE sessions SET stage_visible=?, stage_visibility_source=?, updated_at=? WHERE id=?",
      visible ? 1 : 0,
      source,
      now(),
      sessionId,
    );
    this.emit(sessionId, "stage.visibility", { visible, source });
  }

  private liveArtifact(sessionId: string, artifactId: string): Row | undefined {
    return first(
      this.sql,
      "SELECT * FROM artifacts WHERE id=? AND session_id=? AND deleted=0",
      artifactId,
      sessionId,
    );
  }

  private artifactView(sessionId: string, artifactId: string): ArtifactView {
    return this.mapArtifact(this.liveArtifact(sessionId, artifactId)!);
  }

  private mapArtifact = (row: Row): ArtifactView => {
    const repo = repoOf(row);
    return {
      id: String(row.id),
      kind: row.kind as ArtifactView["kind"],
      title: String(row.title),
      format:
        (optional(row.format) as ArtifactFormat | null) ??
        artifactFormat(row.kind as ArtifactView["kind"], String(row.content)),
      content: String(row.content),
      size: String(row.content).length,
      description: optional(row.description),
      source: optional(row.source),
      revision: Number(row.revision),
      updatedAt: String(row.updated_at),
      ...(row.design_type ? { designType: row.design_type as DesignType } : {}),
      ...(repo
        ? {
            repo: {
              path: repo.path,
              baseCommit: repo.baseCommit,
              pulled: repo.baseContent !== null,
              // Sealed, the client's keyed hashes are compared instead.
              changed: repo.baseTag
                ? repo.baseTag !== optional(row.content_tag)
                : repo.baseContent !== String(row.content),
            },
          }
        : {}),
      keep: row.keep === "1",
    };
  };

  /** What an artifact's frame is built from; sealed in an encrypted interview. */
  artifactParts(sessionId: string, artifactId: string): FrameParts {
    const row = this.liveArtifact(sessionId, artifactId);
    if (!row) throw new Error("Artifact not found");
    const tokens = this.tokensOf(sessionId);
    return {
      kind: row.kind as ArtifactView["kind"],
      designType: (optional(row.design_type) as DesignType | null) ?? null,
      title: String(row.title),
      content: String(row.content),
      format: optional(row.format) as ArtifactFormat | null,
      base: repoOf(row)?.baseContent ?? null,
      tokens: tokens && tokens.id !== row.id ? String(tokens.content) : null,
    };
  }

  /**
   * The artifact as its frame serves it: a design as the viewer's page,
   * the tokens as theirs, a mockup with the tokens inlined. In an
   * encrypted interview, the sealed content as stored: the client builds
   * the page from artifactParts once it has opened them.
   */
  artifactContent(
    sessionId: string,
    artifactId: string,
  ): { format: ArtifactView["format"]; content: string } {
    const parts = this.artifactParts(sessionId, artifactId);
    if (this.kidOf(sessionId))
      return {
        format: parts.format ?? artifactFormat(parts.kind, parts.content),
        content: parts.content,
      };
    return framePage(parts);
  }

  /** The interview's design system tokens, if it has them. */
  private tokensOf(sessionId: string): Row | undefined {
    return first(
      this.sql,
      "SELECT * FROM artifacts WHERE session_id=? AND kind='tokens' AND deleted=0 ORDER BY created_at LIMIT 1",
      sessionId,
    );
  }

  /** Mockups that use the tokens learn their revision, to reload when they change. */
  private withTokensRevision(
    sessionId: string,
    artifacts: ArtifactView[],
  ): ArtifactView[] {
    const tokens = this.tokensOf(sessionId);
    if (!tokens) return artifacts;
    return artifacts.map((artifact) =>
      artifact.format === "html" &&
      artifact.kind !== "tokens" &&
      artifact.kind !== "design" &&
      // Sealed, it can't be told whether a mockup uses them: say so for all.
      (this.kidOf(sessionId) !== null || usesTokens(artifact.content ?? ""))
        ? { ...artifact, tokensRevision: Number(tokens.revision) }
        : artifact,
    );
  }

  /**
   * What `kim` writes to the repo when the interview stops: each artifact
   * the agent kept, whole, with the repo copy it was pulled from.
   */
  keptArtifacts(sessionId: string): KeptArtifact[] {
    this.requireSession(sessionId);
    return this.sql
      .all(
        "SELECT * FROM artifacts WHERE session_id=? AND deleted=0 AND keep='1' ORDER BY created_at",
        sessionId,
      )
      .map((row) => ({
        id: String(row.id),
        kind: row.kind as ArtifactView["kind"],
        title: String(row.title),
        ...(row.design_type
          ? { designType: row.design_type as DesignType }
          : {}),
        content: String(row.content),
        repo: repoOf(row),
        revision: Number(row.revision),
      }));
  }

  private validateLinks(
    sessionId: string,
    artifactId: string | null,
    optionArtifacts: Record<string, string>,
    options: string[],
    sealed: boolean,
  ): void {
    checkLinks(
      (id) => this.artifactRef(sessionId, id),
      artifactId,
      optionArtifacts,
      options,
      sealed,
    );
  }

  private validateBinding(
    sessionId: string,
    question: Parameters<typeof checkBinding>[1],
    sealed: boolean,
  ): void {
    checkBinding((id) => this.artifactRef(sessionId, id), question, sealed);
  }

  private artifactRef(
    sessionId: string,
    artifactId: string,
  ): ArtifactRef | undefined {
    const row = this.liveArtifact(sessionId, artifactId);
    return row ? this.mapArtifact(row) : undefined;
  }

  /** Bound questions an edited artifact no longer serves, as warnings. */
  private bindingWarnings(sessionId: string, artifactId: string): string[] {
    const artifact = this.artifactView(sessionId, artifactId);
    return bindingWarnings(this.getSession(sessionId, "").questions, {
      ...artifact,
      content: artifact.content!,
    });
  }

  // ------------------------------------------------------------ encryption

  /** The interview's key id when it is end-to-end encrypted, else null. */
  kidOf(sessionId: string): string | null {
    const row = first(
      this.sql,
      "SELECT kid FROM sessions WHERE id = ?",
      sessionId,
    );
    if (!row) throw new Error("Session not found");
    return optional(row.kid);
  }

  /** Who holds the interview key: each grant, by the fingerprint it is wrapped to. */
  grants(sessionId: string): Grant[] {
    return this.sql
      .all(
        "SELECT fp, role, wrapped FROM grants WHERE session_id = ? ORDER BY created_at, rowid",
        sessionId,
      )
      .map((row) => ({
        fp: String(row.fp),
        role: row.role as Grant["role"],
        wrapped: String(row.wrapped),
      }));
  }

  private grantSummary(sessionId: string) {
    const grants = this.grants(sessionId);
    return {
      grants: grants.map((grant) => grant.fp),
      assigneeKey: grants.some((grant) => grant.role === "assignee"),
    };
  }

  /** The grants to one key, for these key ids (or every interview's). */
  grantsTo(
    fp: string,
    kids: string[] | null,
  ): Array<{ kid: string; wrapped: string; sessionId: string }> {
    return this.sql
      .all(
        "SELECT s.id, s.kid, g.wrapped FROM grants g JOIN sessions s ON s.id = g.session_id WHERE g.fp = ?",
        fp,
      )
      .filter((row) => !kids || kids.includes(String(row.kid)))
      .map((row) => ({
        kid: String(row.kid),
        wrapped: String(row.wrapped),
        sessionId: String(row.id),
      }));
  }

  /**
   * Adds members' grants; a grant to a key already holding one replaces
   * it. Only the owner's clients, which hold the key, make them.
   */
  addGrants(sessionId: string, input: unknown[]): Grant[] {
    if (!this.kidOf(sessionId))
      throw new Error("This interview isn't encrypted");
    const grants = input.map((grant) => GrantSchema.parse(grant));
    if (this.grants(sessionId).length + grants.length > 40)
      throw new Error(`${LIMIT_REACHED}: an interview has at most 40 grants`);
    for (const grant of grants)
      this.sql.all(
        `INSERT INTO grants (session_id, fp, role, wrapped, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id, fp) DO NOTHING`,
        sessionId,
        grant.fp,
        grant.role,
        grant.wrapped,
        now(),
      );
    return this.grants(sessionId);
  }

  /** The account's key: its public half, and how devices unlock the private half. */
  accountKey(): {
    publicKey: PublicKey;
    fingerprint: string;
    createdAt: string;
    unlocks: Unlock[];
  } | null {
    const row = first(this.sql, "SELECT * FROM account_key WHERE id = 1");
    if (!row) return null;
    return {
      publicKey: json<PublicKey>(row.public_key),
      fingerprint: String(row.fp),
      createdAt: String(row.created_at),
      unlocks: this.sql
        .all("SELECT * FROM unlocks ORDER BY created_at, rowid")
        .map((unlock) => ({
          id: String(unlock.id),
          method: unlock.method as Unlock["method"],
          ...(unlock.credential_id
            ? { credentialId: String(unlock.credential_id) }
            : {}),
          salt: String(unlock.salt),
          wrapped: String(unlock.wrapped),
          ...(unlock.label ? { label: String(unlock.label) } : {}),
          createdAt: String(unlock.created_at),
        })),
    };
  }

  /**
   * Sets up encryption: once. Replacing the key would strand every
   * encrypted interview, so that's a separate, deliberate reset.
   */
  setAccountKey(
    publicKey: PublicKey,
    fingerprint: string,
    unlocks: unknown[],
  ): void {
    if (this.accountKey())
      throw new Error("Encryption is already set up for this account");
    this.sql.transaction(() => {
      this.sql.all(
        "INSERT INTO account_key (id, public_key, fp, created_at) VALUES (1, ?, ?, ?)",
        JSON.stringify(publicKey),
        fingerprint,
        now(),
      );
      for (const unlock of unlocks) this.insertUnlock(unlock);
    });
  }

  addUnlock(unlock: unknown): void {
    if (!this.accountKey()) throw new Error("Set up encryption first");
    if (Number(first(this.sql, "SELECT COUNT(*) n FROM unlocks")!.n) >= 20)
      throw new Error(`${LIMIT_REACHED}: at most 20 ways to unlock`);
    this.insertUnlock(unlock);
  }

  private insertUnlock(input: unknown): void {
    const unlock = UnlockSchema.parse(input);
    if (unlock.method === "passkey" && !unlock.credentialId)
      throw new Error("A passkey unlock needs its credential id");
    this.sql.all(
      `INSERT INTO unlocks (id, method, credential_id, salt, wrapped, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET method=excluded.method, credential_id=excluded.credential_id,
         salt=excluded.salt, wrapped=excluded.wrapped, label=excluded.label`,
      unlock.id,
      unlock.method,
      unlock.credentialId ?? null,
      unlock.salt,
      unlock.wrapped,
      unlock.label ?? null,
      now(),
    );
  }

  /** Removes a way to unlock; the last one stays, or nothing could. */
  removeUnlock(id: string): void {
    const count = Number(first(this.sql, "SELECT COUNT(*) n FROM unlocks")!.n);
    if (!first(this.sql, "SELECT 1 FROM unlocks WHERE id = ?", id))
      throw new Error("Unlock not found");
    if (count <= 1) throw new Error("That's the only way left to unlock");
    this.sql.all("DELETE FROM unlocks WHERE id = ?", id);
  }

  /**
   * Starts encryption over with no key: for someone who lost every
   * device and their recovery code. Encrypted interviews stay, unreadable.
   */
  resetAccountKey(): void {
    this.sql.transaction(() => {
      const old = first(this.sql, "SELECT fp FROM account_key WHERE id = 1");
      if (old) this.sql.all("DELETE FROM grants WHERE fp = ?", String(old.fp));
      this.sql.all("DELETE FROM unlocks");
      this.sql.all("DELETE FROM account_key");
    });
  }

  undeliveredEvents(sessionId: string): InterviewEvent[] {
    return this.sql
      .all(
        "SELECT * FROM events WHERE session_id=? AND delivered=0 ORDER BY id",
        sessionId,
      )
      .map(this.mapEvent);
  }

  markDelivered(sessionId: string, throughId: number): void {
    this.sql.all(
      "UPDATE events SET delivered=1 WHERE session_id=? AND id<=?",
      sessionId,
      throughId,
    );
    this.sql.all(
      `UPDATE answers SET delivered=1 WHERE event_id IN (SELECT id FROM events WHERE session_id=? AND id<=? AND delivered=1)`,
      sessionId,
      throughId,
    );
    this.sql.all(
      "UPDATE chat_messages SET delivered=1 WHERE session_id=? AND event_id<=? AND delivered=0",
      sessionId,
      throughId,
    );
  }

  private emit(
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
  ): InterviewEvent {
    const createdAt = now();
    const row = first(
      this.sql,
      "INSERT INTO events (session_id,type,payload,created_at) VALUES (?,?,?,?) RETURNING id",
      sessionId,
      type,
      JSON.stringify(payload),
      createdAt,
    )!;
    const event = { id: Number(row.id), sessionId, type, payload, createdAt };
    for (const listener of this.listeners) listener(event);
    return event;
  }
  private mapEvent = (row: Row): InterviewEvent => ({
    id: Number(row.id),
    sessionId: String(row.session_id),
    type: String(row.type),
    payload: json(row.payload),
    createdAt: String(row.created_at),
  });
  /** Rows in a table, for the workspace or one interview. */
  private count(
    table: "sessions" | "questions" | "artifacts" | "chat_messages",
    sessionId?: string,
  ): number {
    const row =
      sessionId === undefined
        ? first(this.sql, `SELECT COUNT(*) n FROM ${table}`)
        : first(
            this.sql,
            `SELECT COUNT(*) n FROM ${table} WHERE session_id = ?`,
            sessionId,
          );
    return Number(row?.n ?? 0);
  }
  private requireSession(id: string): void {
    if (!first(this.sql, "SELECT 1 FROM sessions WHERE id=?", id))
      throw new Error("Session not found");
  }
  private requireActive(id: string): void {
    const row = first(this.sql, "SELECT status FROM sessions WHERE id=?", id);
    if (!row) throw new Error("Session not found");
    if (row.status !== "active") throw new Error("Session is stopped");
  }
  private questionRow(sessionId: string, questionId: string): Row {
    const row = first(
      this.sql,
      "SELECT * FROM questions WHERE id=? AND session_id=? AND deleted=0",
      questionId,
      sessionId,
    );
    if (!row) throw new Error("Question not found");
    return row;
  }
}

/**
 * Checks that every sealed field in a value is under this interview's key,
 * so a client can't slip in one it couldn't open itself. Returns the value.
 */
function sealedUnder<T>(kid: string, value: T): T {
  for (const found of kidsIn(value))
    if (found !== kid)
      throw new Error("A field is sealed with another interview's key");
  return value;
}

/** An artifact's content and source share a row, which holds at most 2 MB. */
/** An artifact to write to the repo, with the copy it came from. */
export interface KeptArtifact {
  id: string;
  kind: ArtifactView["kind"];
  title: string;
  designType?: DesignType;
  content: string;
  repo: RepoOrigin | null;
  revision: number;
}

/** The repo origin stored with an artifact, if it came from the repo. */
function repoOf(row: Row): RepoOrigin | null {
  if (!row.repo) return null;
  try {
    const repo = JSON.parse(String(row.repo)) as Partial<RepoOrigin>;
    if (typeof repo.path !== "string") return null;
    return {
      path: repo.path,
      baseCommit: repo.baseCommit ?? null,
      baseContent: repo.baseContent ?? null,
      ...(repo.baseTag ? { baseTag: repo.baseTag } : {}),
    };
  } catch {
    return null;
  }
}

function fitsInRow(
  content: string,
  source: string | null | undefined,
  repo: RepoOrigin | null | undefined = null,
) {
  const encoder = new TextEncoder();
  const bytes =
    encoder.encode(content).length +
    encoder.encode(source ?? "").length +
    encoder.encode(repo?.baseContent ?? "").length;
  if (bytes > ARTIFACT_MAX_BYTES)
    throw new Error(
      `${LIMIT_REACHED}: an artifact's content and source together hold at most ${(ARTIFACT_MAX_BYTES / 1e6).toFixed(1)} MB; this is ${(bytes / 1e6).toFixed(1)} MB`,
    );
}

function mapProject(row: Row): ProjectView {
  return {
    id: String(row.id),
    key: String(row.key),
    name: String(row.name),
    color: String(row.color),
  };
}

function mapOrigin(row: Row): OriginView {
  return {
    branch: optional(row.branch ?? null),
    worktree: optional(row.worktree ?? null),
    agent: optional(row.agent ?? null),
    agentSession: optional(row.agent_session ?? null),
    location:
      (optional(row.location ?? null) as OriginView["location"]) ?? null,
  };
}
