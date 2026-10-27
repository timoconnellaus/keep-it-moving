import {
  AnswerInputSchema,
  ArtifactInputSchema,
  ChatInputSchema,
  ArtifactPatchSchema,
  normalizeDefault,
  QuestionInputSchema,
  QuestionPatchSchema,
  SessionInputSchema,
  type ArtifactView,
  type ChatAuthor,
  type ChatMessageView,
  type InterviewEvent,
  type OriginView,
  type ProjectView,
  type SessionSummary,
  type StageSource,
  type QuestionView,
  type SessionView,
} from "../shared/schema.js";
import { projectName } from "../shared/remote.js";
import { artifactFormat } from "../shared/workspace.js";
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
] as const;

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
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY, created_at TEXT NOT NULL
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
    const { title, stageVisible, origin } = SessionInputSchema.parse(input);
    if (this.count("sessions") >= LIMITS.interviews)
      throw new Error(
        `${LIMIT_REACHED}: a workspace holds at most ${LIMITS.interviews} interviews; delete some (kim session delete --stopped) to make room`,
      );
    const id = crypto.randomUUID();
    const time = now();
    const projectId = this.resolveProject(origin);
    this.sql.all(
      `INSERT INTO sessions (id, title, token, stage_visible, stage_visibility_source, created_at, updated_at,
        project_id, branch, worktree, agent, agent_session, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
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
            WHERE c.session_id = s.id ORDER BY created_at DESC, rowid DESC LIMIT 1) last_author
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
    if (
      !PUSH_SERVICES.some(
        (service) => host === service || host.endsWith(`.${service}`),
      )
    )
      throw new Error(`${host} is not a known push service`);
    this.sql.all(
      "INSERT INTO push_subscriptions (endpoint, created_at) VALUES (?, ?) ON CONFLICT(endpoint) DO NOTHING",
      endpoint,
      now(),
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
    return {
      id: String(session.id),
      title: String(session.title),
      token: String(session.token),
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
      artifacts: artifacts.map(this.mapArtifact),
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
    const parsed = ChatInputSchema.parse(input);
    if (this.count("chat_messages", sessionId) >= LIMITS.chatMessages)
      throw new Error(
        `${LIMIT_REACHED}: an interview's chat holds at most ${LIMITS.chatMessages} messages; start a new interview`,
      );
    const questionId = author === "user" ? (parsed.questionId ?? null) : null;
    const replyTo = author === "agent" ? (parsed.replyTo ?? null) : null;
    if (questionId) this.questionRow(sessionId, questionId);
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
      },
    );
    // Only the user's messages wait to be delivered; the agent wrote its own.
    this.sql.all(
      `INSERT INTO chat_messages (id, session_id, author, text, question_id, reply_to, delivered, event_id, created_at, author_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      for (const table of ["questions", "events", "artifacts", "chat_messages"])
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
    const parsed = inputs.map((item) => {
      const input = QuestionInputSchema.parse(item);
      this.validateLinks(
        sessionId,
        input.artifactId ?? null,
        input.optionArtifacts ?? {},
        input.options,
      );
      return {
        ...input,
        default: normalizeDefault(
          input.type,
          input.options,
          input.default ?? null,
        ),
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
          `INSERT INTO questions (id, session_id, type, prompt, recommendation, default_answer, options, artifact_id, option_artifacts, min, max, step, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          sessionId,
          input.type,
          input.prompt,
          input.recommendation ?? null,
          input.default ? JSON.stringify(input.default) : null,
          JSON.stringify(input.options),
          input.artifactId ?? null,
          JSON.stringify(input.optionArtifacts ?? {}),
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
    const parsed = QuestionPatchSchema.parse(patch);
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
    const defaultAnswer = normalizeDefault(
      type,
      options,
      keep(parsed.default, current.default_answer, (v) => json<string[]>(v)),
    );
    // Options may have been renamed; links to vanished labels are dropped.
    const optionArtifacts = Object.fromEntries(
      Object.entries(
        parsed.optionArtifacts ??
          json<Record<string, string>>(current.option_artifacts),
      ).filter(([label]) => options.includes(label)),
    );
    const artifactId = keep<string>(
      parsed.artifactId,
      current.artifact_id,
      String,
    );
    this.validateLinks(sessionId, artifactId, optionArtifacts, options);
    this.sql.all(
      `UPDATE questions SET type=?, prompt=?, recommendation=?, default_answer=?, options=?, artifact_id=?, option_artifacts=?, min=?, max=?, step=?, position=?, updated_at=? WHERE id=?`,
      type,
      parsed.prompt ?? String(current.prompt),
      keep(parsed.recommendation, current.recommendation, String),
      defaultAnswer ? JSON.stringify(defaultAnswer) : null,
      JSON.stringify(options),
      artifactId,
      JSON.stringify(optionArtifacts),
      keep(parsed.min, current.min, Number),
      keep(parsed.max, current.max, Number),
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
    const parsed = AnswerInputSchema.parse(input);
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
    return { revision, event };
  }

  /** Adds an artifact. A session has one plan, so adding another plan replaces its content. */
  addArtifact(sessionId: string, input: unknown): ArtifactView {
    this.requireActive(sessionId);
    const parsed = ArtifactInputSchema.parse(input);
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
          show: parsed.show,
        });
    }
    if (this.count("artifacts", sessionId) >= LIMITS.artifacts)
      throw new Error(
        `${LIMIT_REACHED}: an interview holds at most ${LIMITS.artifacts} artifacts; update one instead, or start a new interview`,
      );
    const id = crypto.randomUUID();
    const time = now();
    this.sql.all(
      "INSERT INTO artifacts (id,session_id,kind,title,content,description,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id,
      sessionId,
      parsed.kind,
      parsed.title,
      parsed.content,
      parsed.description ?? null,
      parsed.source ?? null,
      time,
      time,
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
    const parsed = ArtifactPatchSchema.parse(patch);
    const changed =
      parsed.title !== undefined ||
      parsed.content !== undefined ||
      parsed.description !== undefined ||
      parsed.source !== undefined;
    if (changed) {
      this.sql.all(
        "UPDATE artifacts SET title=?, content=?, description=?, source=?, revision=revision+1, updated_at=? WHERE id=?",
        parsed.title ?? String(current.title),
        parsed.content ?? String(current.content),
        parsed.description === undefined
          ? optional(current.description)
          : parsed.description,
        parsed.source === undefined ? optional(current.source) : parsed.source,
        now(),
        artifactId,
      );
      this.emit(sessionId, "artifact.updated", {
        artifactId,
        revision: Number(current.revision) + 1,
      });
    }
    if (parsed.show) this.showArtifact(sessionId, artifactId, "agent");
    return this.artifactView(sessionId, artifactId);
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

  private mapArtifact = (row: Row): ArtifactView => ({
    id: String(row.id),
    kind: row.kind as ArtifactView["kind"],
    title: String(row.title),
    format: artifactFormat(
      row.kind as ArtifactView["kind"],
      String(row.content),
    ),
    content: String(row.content),
    size: String(row.content).length,
    description: optional(row.description),
    source: optional(row.source),
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
  });

  /** The raw artifact, for serving html artifacts by URL. */
  artifactContent(
    sessionId: string,
    artifactId: string,
  ): { format: ArtifactView["format"]; content: string } {
    const row = this.liveArtifact(sessionId, artifactId);
    if (!row) throw new Error("Artifact not found");
    const view = this.mapArtifact(row);
    return { format: view.format, content: view.content! };
  }

  private validateLinks(
    sessionId: string,
    artifactId: string | null,
    optionArtifacts: Record<string, string>,
    options: string[],
  ): void {
    // Worded to avoid "not found", which the HTTP layer reports as a 404.
    if (artifactId && !this.liveArtifact(sessionId, artifactId))
      throw new Error(`No artifact ${artifactId} in this session`);
    for (const [label, id] of Object.entries(optionArtifacts)) {
      if (!options.includes(label))
        throw new Error(
          `optionArtifacts names "${label}", which is not an option`,
        );
      if (!this.liveArtifact(sessionId, id))
        throw new Error(`No artifact ${id} in this session`);
    }
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
