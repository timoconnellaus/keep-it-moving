import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import envPaths from "env-paths";
import {
  AnswerInputSchema,
  ArtifactInputSchema,
  ArtifactPatchSchema,
  ClarificationInputSchema,
  NoteInputSchema,
  normalizeDefault,
  QuestionInputSchema,
  QuestionPatchSchema,
  SessionInputSchema,
  type ArtifactView,
  type InterviewEvent,
  type NoteView,
  type StageSource,
  type QuestionView,
  type SessionView,
} from "../shared/schema.js";
import { artifactFormat } from "../shared/workspace.js";

const now = () => new Date().toISOString();
const json = <T>(value: string): T => JSON.parse(value) as T;

export function defaultDatabasePath(): string {
  return `${envPaths("interviewer").data}/interviewer.sqlite`;
}

export class InterviewStore {
  readonly db: DatabaseSync;
  private readonly listeners = new Set<(event: InterviewEvent) => void>();

  constructor(path = defaultDatabasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Untitled interview', token TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', focused_question_id TEXT, focus_source TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        transcript TEXT NOT NULL DEFAULT '[]', resumption_handle TEXT
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL, prompt TEXT NOT NULL, recommendation TEXT, options TEXT NOT NULL DEFAULT '[]',
        min REAL, max REAL, step REAL, position INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS answers (
        question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
        text TEXT NOT NULL, skipped INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0, event_id INTEGER, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clarifications (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL, call_id TEXT NOT NULL, request TEXT NOT NULL, response TEXT,
        status TEXT NOT NULL DEFAULT 'pending', event_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(session_id, call_id)
      );
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sender TEXT NOT NULL, text TEXT NOT NULL, question_id TEXT, speak INTEGER NOT NULL DEFAULT 0,
        call_id TEXT, created_at TEXT NOT NULL, UNIQUE(session_id, call_id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, description TEXT, source TEXT,
        revision INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        session_id TEXT NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL, result TEXT NOT NULL,
        cancelled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY(session_id, call_id)
      );
    `);
    const sessionColumns = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{
      name: string;
    }>;
    if (!sessionColumns.some((column) => column.name === "title"))
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled interview'",
      );
    if (!sessionColumns.some((column) => column.name === "focus_source"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN focus_source TEXT");
    if (
      !sessionColumns.some((column) => column.name === "focused_question_ids")
    )
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN focused_question_ids TEXT NOT NULL DEFAULT '[]'",
      );
    const questionColumns = this.db
      .prepare("PRAGMA table_info(questions)")
      .all() as Array<{ name: string }>;
    if (!questionColumns.some((column) => column.name === "default_answer"))
      this.db.exec("ALTER TABLE questions ADD COLUMN default_answer TEXT");
    if (!questionColumns.some((column) => column.name === "artifact_id"))
      this.db.exec(
        "ALTER TABLE questions ADD COLUMN artifact_id TEXT; ALTER TABLE questions ADD COLUMN option_artifacts TEXT NOT NULL DEFAULT '{}';",
      );
    const artifactColumns = this.db
      .prepare("PRAGMA table_info(artifacts)")
      .all() as Array<{ name: string }>;
    if (!artifactColumns.some((column) => column.name === "source"))
      this.db.exec("ALTER TABLE artifacts ADD COLUMN source TEXT");
    if (!sessionColumns.some((column) => column.name === "stage_artifact_id"))
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN stage_artifact_id TEXT; ALTER TABLE sessions ADD COLUMN stage_source TEXT;",
      );
  }

  close(): void {
    this.db.close();
  }
  subscribe(listener: (event: InterviewEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createSession(baseUrl: string, input: unknown = {}): SessionView {
    const { title } = SessionInputSchema.parse(input);
    const id = randomUUID();
    const token = randomBytes(24).toString("base64url");
    const time = now();
    this.db
      .prepare(
        "INSERT INTO sessions (id, title, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, title, token, time, time);
    this.emit(id, "session.created", { id });
    return this.getSession(id, baseUrl);
  }

  listSessions(baseUrl: string, all = false): SessionView[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM sessions ${all ? "" : "WHERE status = 'active'"} ORDER BY created_at DESC`,
      )
      .all() as Array<{ id: string }>;
    return rows.map((row) => this.getSession(row.id, baseUrl));
  }

  sessionIdForToken(token: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM sessions WHERE token = ?")
      .get(token) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getSession(id: string, baseUrl: string): SessionView {
    const session = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!session) throw new Error("Session not found");
    const questions = this.db
      .prepare(
        `SELECT q.*, a.text answer_text, a.skipped, a.revision, a.delivered, a.updated_at answer_updated_at
      FROM questions q LEFT JOIN answers a ON a.question_id = q.id
      WHERE q.session_id = ? AND q.deleted = 0 ORDER BY q.position, q.created_at`,
      )
      .all(id) as Array<Record<string, unknown>>;
    const clarifications = this.db
      .prepare(
        "SELECT * FROM clarifications WHERE session_id = ? ORDER BY created_at",
      )
      .all(id) as Array<Record<string, unknown>>;
    const notes = (
      this.db
        .prepare(
          "SELECT * FROM notes WHERE session_id = ? ORDER BY rowid DESC LIMIT 50",
        )
        .all(id) as Array<Record<string, unknown>>
    ).reverse();
    const artifacts = this.db
      .prepare(
        "SELECT * FROM artifacts WHERE session_id = ? AND deleted = 0 ORDER BY kind = 'plan' DESC, created_at, rowid",
      )
      .all(id) as Array<Record<string, unknown>>;
    return {
      id: String(session.id),
      title: String(session.title),
      token: String(session.token),
      status: session.status as "active" | "stopped",
      url: `${baseUrl}/s/${String(session.token)}`,
      createdAt: String(session.created_at),
      updatedAt: String(session.updated_at),
      focusedQuestionId: session.focused_question_id
        ? String(session.focused_question_id)
        : null,
      focusedQuestionIds: json<string[]>(String(session.focused_question_ids)),
      focusSource: session.focus_source
        ? (String(session.focus_source) as "agent" | "gemini")
        : null,
      questions: questions.map((row): QuestionView => ({
        id: String(row.id),
        // "range" was retired; its questions render as free-text numbers.
        type:
          row.type === "range" ? "number" : (row.type as QuestionView["type"]),
        prompt: String(row.prompt),
        recommendation:
          row.recommendation === null ? null : String(row.recommendation),
        default:
          row.default_answer === null
            ? null
            : json<string[]>(String(row.default_answer)),
        options: json<string[]>(String(row.options)),
        min: row.min === null ? null : Number(row.min),
        max: row.max === null ? null : Number(row.max),
        step: row.step === null ? null : Number(row.step),
        position: Number(row.position),
        artifactId: row.artifact_id === null ? null : String(row.artifact_id),
        optionArtifacts: json<Record<string, string>>(
          String(row.option_artifacts),
        ),
        answer:
          row.revision === null
            ? null
            : {
                text: String(row.answer_text),
                skipped: Boolean(row.skipped),
                revision: Number(row.revision),
                delivered: Boolean(row.delivered),
                updatedAt: String(row.answer_updated_at),
              },
      })),
      clarifications: clarifications.map((row) => ({
        id: String(row.id),
        questionId: String(row.question_id),
        callId: String(row.call_id),
        request: String(row.request),
        response: row.response === null ? null : String(row.response),
        status: row.status as "pending" | "answered" | "cancelled",
      })),
      notes: notes.map((row): NoteView => ({
        id: String(row.id),
        from: row.sender === "voice" ? "voice" : "agent",
        text: String(row.text),
        questionId: row.question_id === null ? null : String(row.question_id),
        speak: Boolean(row.speak),
        createdAt: String(row.created_at),
      })),
      artifacts: artifacts.map(this.mapArtifact),
      stage: session.stage_artifact_id
        ? {
            artifactId: String(session.stage_artifact_id),
            source: String(session.stage_source) as StageSource,
          }
        : null,
      voice: {
        transcript: json(String(session.transcript)),
        resumptionHandle: session.resumption_handle
          ? String(session.resumption_handle)
          : null,
      },
    };
  }

  setSessionStatus(id: string, status: "active" | "stopped"): void {
    this.requireSession(id);
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now(), id);
    this.emit(
      id,
      status === "active" ? "session.resumed" : "session.stopped",
      {},
    );
  }

  deleteSession(id: string): void {
    this.requireSession(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
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
    const maxRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(position), -1) max FROM questions WHERE session_id = ? AND deleted = 0",
      )
      .get(sessionId) as { max: number };
    let next = maxRow.max + 1;
    const created: string[] = [];
    this.db.exec("BEGIN");
    try {
      for (const input of parsed) {
        const id = randomUUID();
        const time = now();
        const position = input.position ?? next++;
        this.db
          .prepare(
            `INSERT INTO questions (id, session_id, type, prompt, recommendation, default_answer, options, artifact_id, option_artifacts, min, max, step, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
            position,
            time,
            time,
          );
        created.push(id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
    const fields = {
      type: parsed.type ?? String(current.type),
      prompt: parsed.prompt ?? String(current.prompt),
      recommendation:
        parsed.recommendation === undefined
          ? current.recommendation === null
            ? null
            : String(current.recommendation)
          : parsed.recommendation,
      options:
        parsed.options === undefined
          ? String(current.options)
          : JSON.stringify(parsed.options),
      default:
        parsed.default === undefined
          ? current.default_answer === null
            ? null
            : json<string[]>(String(current.default_answer))
          : parsed.default,
      min:
        parsed.min === undefined
          ? current.min === null
            ? null
            : Number(current.min)
          : parsed.min,
      max:
        parsed.max === undefined
          ? current.max === null
            ? null
            : Number(current.max)
          : parsed.max,
      step:
        parsed.step === undefined
          ? current.step === null
            ? null
            : Number(current.step)
          : parsed.step,
      position: parsed.position ?? Number(current.position),
      artifactId:
        parsed.artifactId === undefined
          ? current.artifact_id === null
            ? null
            : String(current.artifact_id)
          : parsed.artifactId,
      optionArtifacts:
        parsed.optionArtifacts ??
        json<Record<string, string>>(String(current.option_artifacts)),
    };
    const type = fields.type === "range" ? "number" : fields.type;
    const options = json<string[]>(fields.options);
    const defaultAnswer = normalizeDefault(
      type as QuestionView["type"],
      options,
      fields.default,
    );
    // Options may have been renamed; links to vanished labels are dropped.
    const optionArtifacts = Object.fromEntries(
      Object.entries(fields.optionArtifacts).filter(([label]) =>
        options.includes(label),
      ),
    );
    this.validateLinks(sessionId, fields.artifactId, optionArtifacts, options);
    this.db
      .prepare(
        `UPDATE questions SET type=?, prompt=?, recommendation=?, default_answer=?, options=?, artifact_id=?, option_artifacts=?, min=?, max=?, step=?, position=?, updated_at=? WHERE id=?`,
      )
      .run(
        type,
        fields.prompt,
        fields.recommendation,
        defaultAnswer ? JSON.stringify(defaultAnswer) : null,
        fields.options,
        fields.artifactId,
        JSON.stringify(optionArtifacts),
        fields.min,
        fields.max,
        fields.step,
        fields.position,
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
    this.db
      .prepare("UPDATE questions SET deleted=1, updated_at=? WHERE id=?")
      .run(now(), questionId);
    const focus = this.getSession(sessionId, "");
    if (focus.focusedQuestionIds.includes(questionId))
      this.writeFocus(
        sessionId,
        focus.focusedQuestionIds.filter((id) => id !== questionId),
        focus.focusSource ?? "agent",
      );
    this.emit(sessionId, "question.deleted", { questionId });
  }

  focusQuestion(
    sessionId: string,
    questionId: string | null,
    source: "agent" | "gemini" = "agent",
  ): void {
    this.focusQuestions(sessionId, questionId ? [questionId] : [], source);
  }

  /** Focuses a group of questions, e.g. the ones voice is discussing together. */
  focusQuestions(
    sessionId: string,
    questionIds: string[],
    source: "agent" | "gemini" = "agent",
  ): void {
    this.requireActive(sessionId);
    const ids = [...new Set(questionIds)];
    for (const id of ids) this.questionRow(sessionId, id);
    this.writeFocus(sessionId, ids, source);
    this.emit(sessionId, "question.focused", {
      questionId: ids[0] ?? null,
      questionIds: ids,
      source,
    });
    // A question about an artifact brings it on screen.
    const lead = ids[0] ? this.questionRow(sessionId, ids[0]) : null;
    const artifactId = lead?.artifact_id ? String(lead.artifact_id) : null;
    const staged = this.db
      .prepare("SELECT stage_artifact_id FROM sessions WHERE id=?")
      .get(sessionId) as { stage_artifact_id: string | null };
    if (
      artifactId &&
      artifactId !== staged.stage_artifact_id &&
      this.liveArtifact(sessionId, artifactId)
    )
      this.showArtifact(sessionId, artifactId, source);
  }

  private writeFocus(
    sessionId: string,
    ids: string[],
    source: "agent" | "gemini",
  ): void {
    this.db
      .prepare(
        "UPDATE sessions SET focused_question_id=?, focused_question_ids=?, focus_source=?, updated_at=? WHERE id=?",
      )
      .run(
        ids[0] ?? null,
        JSON.stringify(ids),
        ids.length ? source : null,
        now(),
        sessionId,
      );
  }

  answerQuestion(
    sessionId: string,
    questionId: string,
    input: unknown,
  ): { revision: number; event: InterviewEvent; duplicate: boolean } {
    this.requireActive(sessionId);
    this.questionRow(sessionId, questionId);
    const parsed = AnswerInputSchema.parse(input);
    if (parsed.callId) {
      const prior = this.db
        .prepare(
          "SELECT result, cancelled FROM tool_calls WHERE session_id=? AND call_id=?",
        )
        .get(sessionId, parsed.callId) as
        { result: string; cancelled: number } | undefined;
      if (prior) return { ...json(prior.result), duplicate: true };
    }
    const previous = this.db
      .prepare("SELECT revision FROM answers WHERE question_id=?")
      .get(questionId) as { revision: number } | undefined;
    const revision = (previous?.revision ?? 0) + 1;
    const event = this.emit(
      sessionId,
      previous ? "answer.revised" : "answer.submitted",
      { questionId, answer: parsed.answer, skipped: parsed.skipped, revision },
    );
    this.db
      .prepare(
        `INSERT INTO answers (question_id,text,skipped,revision,delivered,event_id,updated_at) VALUES (?,?,?,?,0,?,?)
      ON CONFLICT(question_id) DO UPDATE SET text=excluded.text, skipped=excluded.skipped, revision=excluded.revision, delivered=0, event_id=excluded.event_id, updated_at=excluded.updated_at`,
      )
      .run(
        questionId,
        parsed.answer,
        parsed.skipped ? 1 : 0,
        revision,
        event.id,
        now(),
      );
    if (parsed.callId)
      this.db
        .prepare(
          "INSERT INTO tool_calls (session_id,call_id,name,result,created_at) VALUES (?,?,?,?,?)",
        )
        .run(
          sessionId,
          parsed.callId,
          "submit_answer",
          JSON.stringify({ revision, event }),
          now(),
        );
    return { revision, event, duplicate: false };
  }

  /** Adds an artifact. A session has one plan, so adding another plan replaces its content. */
  addArtifact(sessionId: string, input: unknown): ArtifactView {
    this.requireActive(sessionId);
    const parsed = ArtifactInputSchema.parse(input);
    if (parsed.kind === "plan") {
      const plan = this.db
        .prepare(
          "SELECT id FROM artifacts WHERE session_id=? AND kind='plan' AND deleted=0",
        )
        .get(sessionId) as { id: string } | undefined;
      if (plan)
        return this.updateArtifact(sessionId, plan.id, {
          title: parsed.title,
          content: parsed.content,
          ...(parsed.description !== undefined
            ? { description: parsed.description }
            : {}),
          ...(parsed.source !== undefined ? { source: parsed.source } : {}),
          show: parsed.show,
        });
    }
    const id = randomUUID();
    const time = now();
    this.db
      .prepare(
        "INSERT INTO artifacts (id,session_id,kind,title,content,description,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
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
      this.db
        .prepare(
          "UPDATE artifacts SET title=?, content=?, description=?, source=?, revision=revision+1, updated_at=? WHERE id=?",
        )
        .run(
          parsed.title ?? String(current.title),
          parsed.content ?? String(current.content),
          parsed.description === undefined
            ? (current.description as string | null)
            : parsed.description,
          parsed.source === undefined
            ? (current.source as string | null)
            : parsed.source,
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
    this.db
      .prepare("UPDATE artifacts SET deleted=1, updated_at=? WHERE id=?")
      .run(now(), artifactId);
    this.db
      .prepare(
        "UPDATE sessions SET stage_artifact_id=NULL, stage_source=NULL WHERE id=? AND stage_artifact_id=?",
      )
      .run(sessionId, artifactId);
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
    this.db
      .prepare(
        "UPDATE sessions SET stage_artifact_id=?, stage_source=?, updated_at=? WHERE id=?",
      )
      .run(artifactId, artifactId ? source : null, now(), sessionId);
    this.emit(sessionId, "stage.changed", { artifactId, source });
  }

  private liveArtifact(
    sessionId: string,
    artifactId: string,
  ): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        "SELECT * FROM artifacts WHERE id=? AND session_id=? AND deleted=0",
      )
      .get(artifactId, sessionId) as Record<string, unknown> | undefined;
  }

  private artifactView(sessionId: string, artifactId: string): ArtifactView {
    return this.mapArtifact(this.liveArtifact(sessionId, artifactId)!);
  }

  private mapArtifact = (row: Record<string, unknown>): ArtifactView => ({
    id: String(row.id),
    kind: row.kind as ArtifactView["kind"],
    title: String(row.title),
    format: artifactFormat(
      row.kind as ArtifactView["kind"],
      String(row.content),
    ),
    content: String(row.content),
    size: String(row.content).length,
    description: row.description === null ? null : String(row.description),
    source: row.source === null ? null : String(row.source),
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

  /** Records a note from voice (deduplicated by call id) or from the agent. */
  addNote(
    sessionId: string,
    from: "voice" | "agent",
    input: unknown,
  ): { id: string; duplicate: boolean } {
    this.requireActive(sessionId);
    const parsed = NoteInputSchema.parse(input);
    if (parsed.questionId) this.questionRow(sessionId, parsed.questionId);
    if (parsed.callId) {
      const prior = this.db
        .prepare("SELECT id FROM notes WHERE session_id=? AND call_id=?")
        .get(sessionId, parsed.callId) as { id: string } | undefined;
      if (prior) return { id: prior.id, duplicate: true };
    }
    const id = randomUUID();
    const speak = from === "agent" && parsed.speak;
    this.db
      .prepare(
        "INSERT INTO notes (id,session_id,sender,text,question_id,speak,call_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        sessionId,
        from,
        parsed.text,
        parsed.questionId ?? null,
        speak ? 1 : 0,
        parsed.callId ?? null,
        now(),
      );
    this.emit(sessionId, `${from}.note`, {
      noteId: id,
      text: parsed.text,
      questionId: parsed.questionId ?? null,
      ...(from === "agent" ? { speak } : {}),
    });
    return { id, duplicate: false };
  }

  requestClarification(
    sessionId: string,
    input: unknown,
  ): { id: string; duplicate: boolean } {
    this.requireActive(sessionId);
    const parsed = ClarificationInputSchema.parse(input);
    this.questionRow(sessionId, parsed.questionId);
    const prior = this.db
      .prepare("SELECT id FROM clarifications WHERE session_id=? AND call_id=?")
      .get(sessionId, parsed.callId) as { id: string } | undefined;
    if (prior) return { id: prior.id, duplicate: true };
    const id = randomUUID();
    const time = now();
    const event = this.emit(sessionId, "clarification.requested", {
      requestId: id,
      questionId: parsed.questionId,
      request: parsed.request,
      callId: parsed.callId,
    });
    this.db
      .prepare(
        `INSERT INTO clarifications (id,session_id,question_id,call_id,request,event_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        sessionId,
        parsed.questionId,
        parsed.callId,
        parsed.request,
        event.id,
        time,
        time,
      );
    this.db
      .prepare(
        "INSERT INTO tool_calls (session_id,call_id,name,result,created_at) VALUES (?,?,?,?,?)",
      )
      .run(
        sessionId,
        parsed.callId,
        "request_clarification",
        JSON.stringify({ requestId: id }),
        time,
      );
    return { id, duplicate: false };
  }

  replyClarification(
    sessionId: string,
    requestId: string,
    response: string,
  ): void {
    this.requireActive(sessionId);
    const found = this.db
      .prepare(
        "SELECT id FROM clarifications WHERE id=? AND session_id=? AND status='pending'",
      )
      .get(requestId, sessionId);
    if (!found) throw new Error("Pending clarification not found");
    this.db
      .prepare(
        "UPDATE clarifications SET response=?, status='answered', updated_at=? WHERE id=?",
      )
      .run(response, now(), requestId);
    this.emit(sessionId, "clarification.answered", { requestId });
  }

  cancelToolCall(sessionId: string, callId: string): void {
    this.db
      .prepare(
        "UPDATE tool_calls SET cancelled=1 WHERE session_id=? AND call_id=?",
      )
      .run(sessionId, callId);
    this.db
      .prepare(
        "UPDATE clarifications SET status='cancelled', updated_at=? WHERE session_id=? AND call_id=? AND status='pending'",
      )
      .run(now(), sessionId, callId);
    this.emit(sessionId, "tool.cancelled", { callId });
  }

  updateVoice(
    sessionId: string,
    update: {
      role?: "user" | "model";
      text?: string;
      resumptionHandle?: string | null;
    },
  ): void {
    this.requireActive(sessionId);
    const session = this.db
      .prepare("SELECT transcript,resumption_handle FROM sessions WHERE id=?")
      .get(sessionId) as {
      transcript: string;
      resumption_handle: string | null;
    };
    const transcript = json<Array<{ role: "user" | "model"; text: string }>>(
      session.transcript,
    );
    if (update.role && update.text?.trim())
      transcript.push({ role: update.role, text: update.text.trim() });
    const bounded = transcript.slice(-100);
    this.db
      .prepare(
        "UPDATE sessions SET transcript=?, resumption_handle=?, updated_at=? WHERE id=?",
      )
      .run(
        JSON.stringify(bounded),
        update.resumptionHandle === undefined
          ? session.resumption_handle
          : update.resumptionHandle,
        now(),
        sessionId,
      );
  }

  undeliveredEvents(sessionId: string): InterviewEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM events WHERE session_id=? AND delivered=0 ORDER BY id",
        )
        .all(sessionId) as Array<Record<string, unknown>>
    ).map(this.mapEvent);
  }

  markDelivered(sessionId: string, throughId: number): void {
    this.db
      .prepare("UPDATE events SET delivered=1 WHERE session_id=? AND id<=?")
      .run(sessionId, throughId);
    this.db
      .prepare(
        `UPDATE answers SET delivered=1 WHERE event_id IN (SELECT id FROM events WHERE session_id=? AND id<=? AND delivered=1)`,
      )
      .run(sessionId, throughId);
  }

  private emit(
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
  ): InterviewEvent {
    const createdAt = now();
    const result = this.db
      .prepare(
        "INSERT INTO events (session_id,type,payload,created_at) VALUES (?,?,?,?)",
      )
      .run(sessionId, type, JSON.stringify(payload), createdAt);
    const event = {
      id: Number(result.lastInsertRowid),
      sessionId,
      type,
      payload,
      createdAt,
    };
    for (const listener of this.listeners) listener(event);
    return event;
  }
  private mapEvent = (row: Record<string, unknown>): InterviewEvent => ({
    id: Number(row.id),
    sessionId: String(row.session_id),
    type: String(row.type),
    payload: json(String(row.payload)),
    createdAt: String(row.created_at),
  });
  private requireSession(id: string): void {
    if (!this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(id))
      throw new Error("Session not found");
  }
  private requireActive(id: string): void {
    const row = this.db
      .prepare("SELECT status FROM sessions WHERE id=?")
      .get(id) as { status: string } | undefined;
    if (!row) throw new Error("Session not found");
    if (row.status !== "active") throw new Error("Session is stopped");
  }
  private questionRow(
    sessionId: string,
    questionId: string,
  ): Record<string, unknown> {
    const row = this.db
      .prepare(
        "SELECT * FROM questions WHERE id=? AND session_id=? AND deleted=0",
      )
      .get(questionId, sessionId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Question not found");
    return row;
  }
}
