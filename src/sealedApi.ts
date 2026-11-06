import { composeParts, type AnswerParts } from "./shared/answers.js";
import { artifactValues } from "./shared/bindings.js";
import {
  fromBase64Url,
  grantFor,
  importAccountKey,
  kidsIn,
  Keyring,
  newInterviewKey,
  openGrant,
  seal,
  toBase64Url,
  unsealDeep,
  type AccountKey,
  type InterviewKey,
  type PublicKey,
} from "./shared/crypto.js";
import {
  bindingWarnings,
  checkBinding,
  checkLinks,
  completeBatch,
  type ArtifactRef,
} from "./shared/questions.js";
import {
  ArtifactInputSchema,
  ArtifactPatchSchema,
  ChatInputSchema,
  literalLineBreaks,
  normalizeDefault,
  QuestionInputSchema,
  QuestionPatchSchema,
  SessionInputSchema,
  type QuestionView,
  type SessionView,
} from "./shared/schema.js";
import { artifactFormat } from "./shared/workspace.js";
import { renderArtifact } from "./server/artifactView.js";

/**
 * End-to-end encryption in the CLI: between kim's commands and the
 * service. Requests to an encrypted interview are sealed here, after the
 * checks the service would have made on the plain text, and every
 * response is opened here, so the commands and the agent see plain text
 * and the service never does.
 */

/** Sends a request and returns its JSON, or throws the service's error. */
export type RawApi = (path: string, init?: RequestInit) => Promise<unknown>;

const NEEDS_KEY =
  "This interview is end-to-end encrypted, and this CLI doesn't have your key. Run `kim login` (in a cloud session, set KEEP_IT_MOVING_CONTENT_KEY: `kim cloud setup` prints it)";

type Json = Record<string, unknown>;

const SESSION = /^\/api\/sessions\/([^/?]+)/;
const INBOX = /^\/api\/sessions\/inbox\/([A-Za-z0-9_-]{32})/;

export class Encryption {
  private account: Promise<AccountKey | null> | undefined;
  private readonly keys = new Map<string, Promise<InterviewKey | null>>();
  private readonly inboxTokens = new Set<string>();
  private readonly triedTokens = new Set<string>();
  readonly keyring = new Keyring((kids) => this.resolve(kids));

  constructor(
    private readonly raw: RawApi,
    /** The account's private key (PKCS #8, base64url), or null. */
    private readonly storedKey: () => string | null,
  ) {}

  /** The account key this CLI holds, or null when it has none. */
  accountKey(): Promise<AccountKey | null> {
    this.account ??= (async () => {
      const stored = this.storedKey();
      if (!stored) return null;
      try {
        return await importAccountKey(fromBase64Url(stored.trim()));
      } catch {
        throw new Error(
          "KEEP_IT_MOVING_CONTENT_KEY (or the stored key) isn't a valid key; run `kim login` again",
        );
      }
    })();
    return this.account;
  }

  private async resolve(kids: string[]): Promise<Array<InterviewKey | null>> {
    const account = await this.accountKey();
    if (!account) return [];
    const found = new Map<string, InterviewKey>();
    const query = new URLSearchParams([
      ...kids.map((kid) => ["kid", kid]),
      ["fp", account.fingerprint],
    ]);
    const { grants = [] } = (await this.raw(
      `/api/sessions/kim/grants?${query}`,
    ).catch(() => ({}))) as {
      grants?: Array<{ kid: string; wrapped: string }>;
    };
    for (const grant of grants)
      found.set(grant.kid, await openGrant(account, grant.kid, grant.wrapped));
    // Interviews sent to this user are in their senders' workspaces.
    for (const token of this.inboxTokens) {
      if (kids.every((kid) => found.has(kid))) break;
      if (this.triedTokens.has(token)) continue;
      this.triedTokens.add(token);
      const key = await this.inboxKey(token).catch(() => null);
      if (key) found.set(key.kid, key);
    }
    return kids.map((kid) => found.get(kid) ?? null);
  }

  private async grantKey(path: string): Promise<InterviewKey | null> {
    const account = await this.accountKey();
    const grant = (await this.raw(
      `${path}${account ? `?fp=${account.fingerprint}` : ""}`,
    )) as { kid: string | null; wrapped?: string | null };
    if (!grant.kid) return null;
    if (!account) throw new Error(NEEDS_KEY);
    if (!grant.wrapped)
      throw new Error(
        "This interview is end-to-end encrypted, and your key hasn't been given access to it yet. Its owner's page shares it when they next open it",
      );
    const key = await openGrant(account, grant.kid, grant.wrapped);
    this.keyring.add(key);
    return key;
  }

  /** An interview's key, or null when it isn't encrypted. */
  sessionKey(id: string): Promise<InterviewKey | null> {
    const cached = this.keys.get(id);
    if (cached) return cached;
    const key = this.grantKey(`/api/sessions/${encodeURIComponent(id)}/grant`);
    this.keys.set(id, key);
    key.catch(() => this.keys.delete(id));
    return key;
  }

  /** The key of an interview sent to this user, or null when it isn't encrypted. */
  inboxKey(token: string): Promise<InterviewKey | null> {
    const id = `inbox:${token}`;
    const cached = this.keys.get(id);
    if (cached) return cached;
    const key = this.grantKey(`/api/sessions/inbox/${token}/grant`);
    this.keys.set(id, key);
    key.catch(() => this.keys.delete(id));
    return key;
  }

  /** Opens every sealed field in a response, and finishes an encrypted batch. */
  async open<T>(value: T): Promise<T> {
    this.noteTokens(value);
    if (!kidsIn(value).size) return value;
    const opened = await unsealDeep(value, this.keyring);
    const batch = (opened as { batch?: unknown } | null)?.batch;
    return (
      batch && typeof batch === "object"
        ? { ...opened, batch: completeBatch(batch) }
        : completeBatch(opened)
    ) as T;
  }

  /** Interviews sent to the user, named in a list, whose keys may be needed. */
  private noteTokens(value: unknown): void {
    const items = Array.isArray(value)
      ? value
      : Array.isArray((value as { interviews?: unknown })?.interviews)
        ? (value as { interviews: unknown[] }).interviews
        : [value];
    for (const item of items) {
      const id = (item as { id?: unknown } | null)?.id;
      if (typeof id === "string" && /^[A-Za-z0-9_-]{32}$/.test(id))
        this.inboxTokens.add(id);
    }
  }

  /**
   * A request through the encryption layer: sealed when it writes to an
   * encrypted interview, and its response opened.
   */
  async api(path: string, init: RequestInit = {}): Promise<unknown> {
    const method = (init.method ?? "GET").toUpperCase();
    const inbox = INBOX.exec(path)?.[1];
    if (inbox) this.inboxTokens.add(inbox);
    const body =
      typeof init.body === "string" && init.body
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    const route = `${method} ${path.replace(/\?.*$/, "")}`;
    let after: ((response: unknown) => Promise<unknown>) | undefined;
    let sealed: unknown = body;
    try {
      if (route === "POST /api/sessions")
        sealed = await this.createSession(body);
      else if (inbox) sealed = await this.inboxRequest(route, inbox, body);
      else if (body !== undefined) {
        const id = SESSION.exec(path)?.[1];
        const key =
          id && id !== "kim" && id !== "inbox" && id !== "projects"
            ? await this.sessionKey(decodeURIComponent(id))
            : null;
        if (key) {
          const prepared = await this.sessionRequest(
            route,
            decodeURIComponent(id!),
            key,
            body,
          );
          sealed = prepared.body;
          after = prepared.after;
        }
      }
    } catch (error) {
      throw await this.openError(error);
    }
    const response = await this.raw(
      path,
      sealed === body ? init : { ...init, body: JSON.stringify(sealed) },
    ).catch(async (error: unknown) => {
      throw await this.openError(error);
    });
    const opened = await this.open(response);
    return after ? after(opened) : opened;
  }

  /** An error whose message names sealed fields, such as a title. */
  async openError(error: unknown): Promise<unknown> {
    if (!(error instanceof Error) || !kidsIn(error.message).size) return error;
    error.message = await this.open(error.message);
    return error;
  }

  // --------------------------------------------------------- the routes

  /**
   * A new interview is encrypted when the account has a key: under a new
   * interview key, granted to the account's keys (and its linked accounts').
   */
  private async createSession(body: unknown): Promise<unknown> {
    const { publicKey: accountPublic } = (await this.raw(
      "/api/sessions/kim/account",
    )) as { publicKey: PublicKey | null; fingerprint?: string };
    if (!accountPublic) return body;
    const account = await this.accountKey();
    if (!account)
      throw new Error(
        "Your account encrypts interviews end to end, and this CLI doesn't have your key. Run `kim login` (in a cloud session, set KEEP_IT_MOVING_CONTENT_KEY: `kim cloud setup` prints it)",
      );
    const { keys } = (await this.raw("/api/sessions/kim/pubkeys")) as {
      keys: Array<{ fp: string; publicKey: PublicKey }>;
    };
    if (!keys.some((listed) => listed.fp === account.fingerprint))
      throw new Error(
        "This CLI's key is from before your account's encryption was reset. Run `kim login` to get the new one",
      );
    const input = SessionInputSchema.parse(body ?? {});
    const key = await newInterviewKey();
    this.keyring.add(key);
    const origin: Json = { ...input.origin };
    for (const field of ["branch", "worktree", "agentSession"] as const)
      if (input.origin[field])
        origin[field] = await seal(key, input.origin[field]);
    return {
      title: await seal(key, input.title),
      stageVisible: input.stageVisible,
      origin,
      encryption: {
        kid: key.kid,
        grants: await Promise.all(
          keys.map(async (listed) => ({
            fp: listed.fp,
            role: "owner",
            wrapped: await grantFor(listed.publicKey, key),
          })),
        ),
      },
    };
  }

  private async sessionRequest(
    route: string,
    id: string,
    key: InterviewKey,
    body: unknown,
  ): Promise<{
    body: unknown;
    after?: (response: unknown) => Promise<unknown>;
  }> {
    const tail = route.replace(/^(\w+) \/api\/sessions\/[^/]+/, "$1 ");
    const s = (text: string) => seal(key, text);
    if (tail === "POST /questions") {
      const list = Array.isArray(body)
        ? body
        : Array.isArray((body as Json)?.questions)
          ? ((body as Json).questions as unknown[])
          : [body];
      const find = await this.artifactFinder(id);
      return {
        body: await Promise.all(
          list.map(async (item) =>
            sealQuestion(
              checkedQuestion(QuestionInputSchema.parse(item), find),
              s,
            ),
          ),
        ),
      };
    }
    const question = /^PATCH \/questions\/([^/]+)$/.exec(tail)?.[1];
    if (question) {
      const session = await this.session(id);
      const current = session.questions.find((item) => item.id === question);
      if (!current) throw new Error("Question not found");
      const merged = mergeQuestion(current, QuestionPatchSchema.parse(body));
      return {
        body: await sealQuestion(
          checkedQuestion(merged, await this.artifactFinder(id, session)),
          s,
        ),
      };
    }
    if (tail === "POST /artifacts") {
      const input = ArtifactInputSchema.parse(body);
      return {
        body: {
          kind: input.kind,
          format: artifactFormat(input.kind, input.content),
          show: input.show,
          ...(await sealArtifact(input, s)),
        },
      };
    }
    const artifact = /^PATCH \/artifacts\/([^/]+)$/.exec(tail)?.[1];
    if (artifact) {
      const patch = ArtifactPatchSchema.parse(body);
      if (patch.content === undefined)
        return { body: { ...patch, ...(await sealArtifact(patch, s)) } };
      const session = await this.session(id);
      const current = session.artifacts.find((item) => item.id === artifact);
      if (!current) throw new Error("Artifact not found");
      const format = artifactFormat(current.kind, patch.content);
      // The service can't read the markup, so the warnings are made here.
      const warnings = bindingWarnings(session.questions, {
        id: artifact,
        format,
        title: patch.title ?? current.title,
        content: patch.content,
      });
      return {
        body: { ...patch, format, ...(await sealArtifact(patch, s)) },
        after: async (response) =>
          warnings.length ? { ...(response as Json), warnings } : response,
      };
    }
    if (tail === "POST /chat") {
      const input = ChatInputSchema.parse(body);
      return {
        body: { ...input, text: await s(literalLineBreaks(input.text)) },
      };
    }
    if (/^POST \/questions\/[^/]+\/answer$/.test(tail)) {
      const input = body as { answer?: string; skipped?: boolean };
      return {
        body: {
          ...input,
          answer: input.answer ? await s(input.answer) : "",
        },
      };
    }
    if (tail === "POST /assign") {
      const email = (body as { email?: unknown })?.email;
      if (typeof email !== "string" || !email.trim()) return { body };
      const { keys } = (await this.raw(
        `/api/sessions/kim/pubkeys?email=${encodeURIComponent(email.trim())}`,
      )) as { keys: Array<{ fp: string; publicKey: PublicKey }> };
      const grants = await Promise.all(
        keys.map(async (listed) => ({
          fp: listed.fp,
          wrapped: await grantFor(listed.publicKey, key),
        })),
      );
      return {
        body: { ...(body as Json), grants },
        after: async (response) =>
          grants.length
            ? response
            : {
                ...(response as Json),
                encryption: `${email.trim()} hasn't set up encryption yet, so they can't open it until they have and you've opened the interview's page once after that`,
              },
      };
    }
    return { body };
  }

  /** An interview sent to the user: the agent's answers and messages, sealed. */
  private async inboxRequest(
    route: string,
    token: string,
    body: unknown,
  ): Promise<unknown> {
    const tail = route.replace(/^(\w+) \/api\/sessions\/inbox\/[^/]+/, "$1 ");
    const answer =
      /^(PUT \/questions\/([^/]+)\/draft|POST \/questions\/([^/]+)\/answer)$/.exec(
        tail,
      );
    const isChat = tail === "POST /chat";
    if (!answer && !isChat) return body;
    const key = await this.inboxKey(token);
    if (!key) return body;
    if (isChat) {
      const input = body as { text?: unknown; question?: unknown };
      if (typeof input.text !== "string" || !input.text.trim())
        throw new Error("Give the message: kim inbox chat <interview> <text>");
      return { ...input, text: await seal(key, literalLineBreaks(input.text)) };
    }
    const ref = answer![2] ?? answer![3]!;
    const { question } = (await this.open(
      await this.raw(`/api/sessions/inbox/${token}/questions/${ref}`),
    )) as { question: QuestionView };
    const composed = composeParts(question, body as AnswerParts);
    return {
      answer: composed.answer ? await seal(key, composed.answer) : "",
      skipped: composed.skipped,
    };
  }

  /** An interview sent to the user's artifact, as its frame serves it. */
  async inboxArtifact(response: unknown): Promise<unknown> {
    const artifact = response as Json & {
      id: string;
      content?: string;
      questions?: QuestionView[];
    };
    if (!artifact.questions) return response;
    const { questions, ...rest } = artifact;
    return {
      ...rest,
      content: renderArtifact(
        artifact.content ?? "",
        artifactValues(questions, artifact.id),
      ),
    };
  }

  // ------------------------------------------------------------ helpers

  private async session(id: string): Promise<SessionView> {
    return this.open(
      (await this.raw(
        `/api/sessions/${encodeURIComponent(id)}`,
      )) as SessionView,
    );
  }

  /** The interview's artifacts, read on demand, for the question checks. */
  private async artifactFinder(id: string, known?: SessionView) {
    const session = known ?? (await this.session(id));
    const contents = new Map<string, string>();
    for (const artifact of session.artifacts)
      if (artifact.format === "html") {
        const { content } = (await this.open(
          await this.raw(
            `/api/sessions/${encodeURIComponent(id)}/artifacts/${artifact.id}/content`,
          ),
        )) as { content: string };
        contents.set(artifact.id, content);
      }
    return (artifactId: string): ArtifactRef | undefined => {
      const artifact = session.artifacts.find((item) => item.id === artifactId);
      return artifact && { ...artifact, content: contents.get(artifactId) };
    };
  }
}

type ParsedQuestion = ReturnType<typeof QuestionInputSchema.parse>;

/** A question checked as the service checks a plain one, its default normalised. */
function checkedQuestion(
  question: ParsedQuestion,
  find: (id: string) => ArtifactRef | undefined,
): ParsedQuestion {
  const normalized = {
    ...question,
    default: normalizeDefault(
      question.type,
      question.options,
      question.default ?? null,
    ),
  };
  checkLinks(
    find,
    question.artifactId ?? null,
    question.optionArtifacts ?? {},
    question.options,
  );
  checkBinding(find, {
    type: question.type,
    options: question.options,
    artifactId: question.artifactId ?? null,
    optionValues: question.optionValues ?? {},
    control: question.control ?? null,
    unit: question.unit ?? null,
    min: question.min ?? null,
    max: question.max ?? null,
  });
  return normalized;
}

/** A question as stored, with a patch over it: an omitted field keeps its value. */
function mergeQuestion(
  current: QuestionView,
  patch: ReturnType<typeof QuestionPatchSchema.parse>,
): ParsedQuestion {
  const pick = <K extends keyof QuestionView & keyof typeof patch>(field: K) =>
    patch[field] === undefined ? current[field] : patch[field];
  const options = patch.options ?? current.options;
  // Links to labels that are no longer options go, as the service drops them.
  const labelled = <T>(record: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(record).filter(([label]) => options.includes(label)),
    );
  const merged = {
    type: patch.type ?? current.type,
    prompt: patch.prompt ?? current.prompt,
    recommendation: pick("recommendation"),
    default: pick("default"),
    options,
    artifactId: pick("artifactId"),
    optionArtifacts: labelled(patch.optionArtifacts ?? current.optionArtifacts),
    optionValues: labelled(patch.optionValues ?? current.optionValues),
    control: pick("control"),
    unit: pick("unit"),
    min: pick("min"),
    max: pick("max"),
    step: pick("step"),
    position: patch.position ?? current.position,
  };
  return merged as ParsedQuestion;
}

async function sealQuestion(
  question: ParsedQuestion,
  s: (text: string) => Promise<string>,
): Promise<Json> {
  const sealedRecord = async <T>(
    record: Record<string, T> | undefined,
    value: (item: T) => Promise<unknown>,
  ) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(record ?? {}).map(
          async ([label, item]) => [await s(label), await value(item)] as const,
        ),
      ),
    );
  return {
    ...question,
    prompt: await s(question.prompt),
    recommendation:
      question.recommendation == null ? null : await s(question.recommendation),
    default: question.default
      ? await Promise.all(question.default.map(s))
      : null,
    options: await Promise.all(question.options.map(s)),
    optionArtifacts: await sealedRecord(
      question.optionArtifacts,
      async (id) => id,
    ),
    optionValues: await sealedRecord(question.optionValues, async (values) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(values).map(
            async ([control, value]) => [control, await s(value)] as const,
          ),
        ),
      ),
    ),
  };
}

async function sealArtifact(
  input: {
    title?: string | undefined;
    content?: string | undefined;
    description?: string | null | undefined;
    source?: string | null | undefined;
  },
  s: (text: string) => Promise<string>,
): Promise<Json> {
  const out: Json = {};
  if (input.title !== undefined) out.title = await s(input.title);
  if (input.content !== undefined) out.content = await s(input.content);
  if (input.description !== undefined)
    out.description =
      input.description === null ? null : await s(input.description);
  if (input.source !== undefined)
    out.source = input.source === null ? null : await s(input.source);
  return out;
}

/** The account key as the CLI stores it and KEEP_IT_MOVING_CONTENT_KEY holds it. */
export const encodeContentKey = (account: AccountKey) =>
  toBase64Url(account.pkcs8);
