import { createContext, useSyncExternalStore } from "react";
import {
  fromBase64Url,
  grantFor,
  importAccountKey,
  kidsIn,
  Keyring,
  lockAccountKey,
  newAccountKey,
  newRecoveryCode,
  newSalt,
  openGrant,
  parseRecoveryCode,
  seal,
  toBase64Url,
  unlockAccountKey,
  unsealDeep,
  wrapTo,
  type AccountKey,
  type InterviewKey,
  type PublicKey,
  type Unlock,
} from "../shared/crypto.js";

/**
 * End-to-end encryption in the browser. The account's private key is kept
 * in this browser's IndexedDB once unlocked (by a passkey or the recovery
 * code); the service holds it only wrapped. Interview keys come from
 * grants, opened with it, and every response is opened here.
 */

export type EncryptionStatus =
  | "loading"
  /** The account hasn't set up encryption. */
  | "off"
  /** It has, and this browser hasn't been unlocked. */
  | "locked"
  | "unlocked";

/** The account's key as the service keeps it. */
export interface ServerKey {
  publicKey: PublicKey;
  fingerprint: string;
  unlocks: Unlock[];
}

export interface EncryptionState {
  status: EncryptionStatus;
  email: string | null;
  server: ServerKey | null;
  /** Whether this browser can unlock with a passkey at all. */
  passkeys: boolean;
}

// ----------------------------------------------------------- IndexedDB

const DB_NAME = "kim-encryption";
const STORE = "account-keys";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB"));
  });
}

async function stored(
  mode: IDBTransactionMode,
  act: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = act(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB"));
  }).finally(() => db.close());
}

const readKey = (email: string) =>
  stored("readonly", (store) => store.get(email)).catch(() => null) as Promise<
    string | null | undefined
  >;
const writeKey = (email: string, pkcs8: Uint8Array<ArrayBuffer>) =>
  stored("readwrite", (store) => store.put(toBase64Url(pkcs8), email));
const forgetKey = (email: string) =>
  stored("readwrite", (store) => store.delete(email)).catch(() => undefined);

// ------------------------------------------------------------- requests

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(reply.error ?? `HTTP ${response.status}`);
  return reply;
}

// ------------------------------------------------------------- passkeys

interface PrfResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

const passkeysAvailable = () =>
  typeof window !== "undefined" &&
  typeof window.PublicKeyCredential !== "undefined" &&
  typeof navigator.credentials?.create === "function";

const random = (length: number) =>
  crypto.getRandomValues(new Uint8Array(length));

/** A passkey's PRF output for its salt: the secret that unlocks the account key. */
async function passkeySecret(
  unlocks: Unlock[],
): Promise<{ unlock: Unlock; secret: Uint8Array<ArrayBuffer> }> {
  const passkeys = unlocks.filter(
    (unlock) => unlock.method === "passkey" && unlock.credentialId,
  );
  if (!passkeys.length) throw new Error("No passkey unlocks this account yet");
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      rpId: location.hostname,
      userVerification: "required",
      allowCredentials: passkeys.map((unlock) => ({
        type: "public-key",
        id: fromBase64Url(unlock.credentialId!),
      })),
      extensions: {
        prf: {
          evalByCredential: Object.fromEntries(
            passkeys.map((unlock) => [
              unlock.credentialId!,
              { first: fromBase64Url(unlock.salt) },
            ]),
          ),
        },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was used");
  const used = toBase64Url(new Uint8Array(credential.rawId));
  const unlock = passkeys.find((item) => item.credentialId === used);
  const output = (credential.getClientExtensionResults() as PrfResults).prf
    ?.results?.first;
  if (!unlock || !output)
    throw new Error(
      "That passkey can't unlock encryption here: its password manager doesn't support it. Use your recovery code",
    );
  return { unlock, secret: new Uint8Array(output) };
}

/**
 * A new passkey for this account, and its unlock: the account key sealed
 * under the passkey's PRF output. Null when the browser or password
 * manager can't give PRF output, so the recovery code is the way in.
 */
async function createPasskeyUnlock(
  account: AccountKey,
  email: string,
): Promise<Unlock | null> {
  if (!passkeysAvailable()) return null;
  const salt = newSalt();
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Keep it moving", id: location.hostname },
      user: { id: random(16), name: email, displayName: email },
      challenge: random(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      extensions: {
        prf: { eval: { first: salt } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) return null;
  const credentialId = toBase64Url(new Uint8Array(credential.rawId));
  const prf = (credential.getClientExtensionResults() as PrfResults).prf;
  let output = prf?.results?.first;
  // Some authenticators only say PRF works when creating; ask for it now.
  if (!output && prf?.enabled)
    output = (
      await passkeySecret([
        {
          id: credentialId,
          method: "passkey",
          credentialId,
          salt: toBase64Url(salt),
          wrapped: "",
        },
      ]).catch(() => null)
    )?.secret.buffer;
  if (!output) return null;
  return {
    id: toBase64Url(random(12)),
    method: "passkey",
    credentialId,
    salt: toBase64Url(salt),
    wrapped: await lockAccountKey(
      account,
      "passkey",
      new Uint8Array(output),
      salt,
    ),
    label: navigator.platform ? `Passkey (${navigator.platform})` : "Passkey",
  };
}

// --------------------------------------------------------------- state

class BrowserEncryption {
  private state: EncryptionState = {
    status: "loading",
    email: null,
    server: null,
    passkeys: passkeysAvailable(),
  };
  private account: AccountKey | null = null;
  private readonly listeners = new Set<() => void>();
  private started: Promise<void> | null = null;
  /** Interviews this page reaches by token: as an assignee, or shared lists. */
  private readonly tokens = new Set<string>();
  private readonly triedTokens = new Set<string>();
  readonly keyring = new Keyring((kids) => this.resolve(kids));

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    void this.start();
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.state;

  private set(patch: Partial<EncryptionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Loads the account's key state and this browser's key, once. */
  start(): Promise<void> {
    this.started ??= (async () => {
      try {
        const me = await getJson<{ email: string }>("/api/browser/me");
        const server = await getJson<ServerKey | { publicKey: null }>(
          "/api/browser/account/key",
        );
        const email = me.email.toLowerCase();
        if (!server.publicKey) {
          this.set({ status: "off", email, server: null });
          return;
        }
        const kept = await readKey(email);
        if (kept) {
          const account = await importAccountKey(fromBase64Url(kept)).catch(
            () => null,
          );
          if (account?.fingerprint === server.fingerprint) {
            this.account = account;
            this.set({ status: "unlocked", email, server });
            return;
          }
          // A key from before a reset opens nothing now.
          await forgetKey(email);
        }
        this.set({ status: "locked", email, server });
      } catch {
        this.set({ status: "off" });
      }
    })();
    return this.started;
  }

  /** Waits for the state to load; resolves to whether this browser can open things. */
  async ready(): Promise<boolean> {
    await this.start();
    return this.state.status === "unlocked";
  }

  private async resolve(kids: string[]): Promise<Array<InterviewKey | null>> {
    await this.start();
    const account = this.account;
    if (!account) return [];
    const found = new Map<string, InterviewKey>();
    const query = new URLSearchParams([
      ...kids.map((kid) => ["kid", kid]),
      ["fp", account.fingerprint],
    ]);
    const { grants = [] } = await getJson<{
      grants?: Array<{ kid: string; wrapped: string }>;
    }>(`/api/browser/grants?${query}`).catch(() => ({ grants: [] }));
    for (const grant of grants) {
      const key = await openGrant(account, grant.kid, grant.wrapped).catch(
        () => null,
      );
      if (key) found.set(grant.kid, key);
    }
    for (const token of this.tokens) {
      if (kids.every((kid) => found.get(kid))) break;
      if (this.triedTokens.has(token)) continue;
      const grant = await getJson<{
        kid: string | null;
        wrapped?: string | null;
      }>(`/api/browser/${token}/grant?fp=${account.fingerprint}`).catch(
        () => null,
      );
      if (!grant?.kid || !grant.wrapped) continue;
      this.triedTokens.add(token);
      const key = await openGrant(account, grant.kid, grant.wrapped).catch(
        () => null,
      );
      if (key) found.set(key.kid, key);
    }
    return kids.map((kid) => found.get(kid) ?? null);
  }

  /** An interview this page reaches by its token, whose grant may be needed. */
  noteToken(token: string) {
    if (/^[A-Za-z0-9_-]{32}$/.test(token)) this.tokens.add(token);
  }

  /** The value with every sealed field opened, or locked where it can't be. */
  async unseal<T>(value: T): Promise<T> {
    if (!kidsIn(value).size) return value;
    await this.start();
    return unsealDeep(value, this.keyring);
  }

  /** Whether this browser holds the key to an interview. */
  async canOpen(kid: string): Promise<boolean> {
    if (!(await this.ready())) return false;
    // A grant added since this page last asked is worth another look.
    this.triedTokens.clear();
    return Boolean(await this.keyring.get(kid));
  }

  /** Seals text under an interview's key, or leaves it for a plain one. */
  async sealFor(kid: string | null, text: string): Promise<string> {
    if (!kid) return text;
    const key = await this.keyring.get(kid);
    if (!key)
      throw new Error(
        "This interview is end-to-end encrypted. Unlock it on this device to answer",
      );
    return seal(key, text);
  }

  // ------------------------------------------------------------ setup

  /** The first step: a new key, and the recovery code that will unlock it. */
  async prepareSetup() {
    const account = await newAccountKey();
    const recovery = newRecoveryCode();
    const salt = newSalt();
    const unlock: Unlock = {
      id: toBase64Url(random(12)),
      method: "recovery",
      salt: toBase64Url(salt),
      wrapped: await lockAccountKey(account, "recovery", recovery.secret, salt),
      label: "Recovery code",
    };
    return { account, code: recovery.code, unlock };
  }

  /** A passkey for a key being set up; null when PRF isn't available. */
  async passkeyFor(account: AccountKey): Promise<Unlock | null> {
    await this.start();
    return createPasskeyUnlock(account, this.state.email ?? "you");
  }

  /** Saves the key with its unlocks, and keeps it in this browser. */
  async finishSetup(account: AccountKey, unlocks: Unlock[]): Promise<void> {
    await this.start();
    await postJson("/api/browser/account/key", {
      publicKey: account.publicKey,
      unlocks,
    });
    await this.remember(account);
    const server = await getJson<ServerKey>("/api/browser/account/key");
    this.set({ status: "unlocked", server });
  }

  private async remember(account: AccountKey) {
    this.account = account;
    if (this.state.email) await writeKey(this.state.email, account.pkcs8);
  }

  async unlockWithPasskey(): Promise<void> {
    await this.start();
    const { unlock, secret } = await passkeySecret(
      this.state.server?.unlocks ?? [],
    );
    await this.unlocked(await unlockAccountKey(unlock, secret));
  }

  async unlockWithCode(code: string): Promise<void> {
    await this.start();
    const recovery = this.state.server?.unlocks.find(
      (unlock) => unlock.method === "recovery",
    );
    if (!recovery) throw new Error("This account has no recovery code");
    await this.unlocked(
      await unlockAccountKey(recovery, parseRecoveryCode(code)),
    );
  }

  private async unlocked(account: AccountKey) {
    if (account.fingerprint !== this.state.server?.fingerprint)
      throw new Error("That key isn't this account's current one");
    await this.remember(account);
    this.triedTokens.clear();
    this.set({ status: "unlocked" });
  }

  /** Adds a passkey to an unlocked account; false when PRF isn't available. */
  async addPasskey(): Promise<boolean> {
    if (!this.account) throw new Error("Unlock first");
    const unlock = await createPasskeyUnlock(
      this.account,
      this.state.email ?? "you",
    );
    if (!unlock) return false;
    const server = await postJson<ServerKey>("/api/browser/account/unlocks", {
      unlock,
    });
    this.set({ server });
    return true;
  }

  /** Forgets the key in this browser; a passkey or the code unlocks it again. */
  async lock(): Promise<void> {
    if (this.state.email) await forgetKey(this.state.email);
    this.account = null;
    this.set({ status: this.state.server ? "locked" : "off" });
  }

  /**
   * Starts over without the old key, for someone who lost every way to
   * unlock: what was encrypted under it can't be read again.
   */
  async reset(): Promise<void> {
    await postJson("/api/browser/account/reset", {});
    await this.lock();
    this.set({ status: "off", server: null });
  }

  /** The private key, wrapped for a CLI's one-off key: `kim login`'s hand-off. */
  async wrapForCli(cliPublic: PublicKey): Promise<string> {
    if (!this.account) throw new Error("Unlock first");
    return wrapTo(cliPublic, this.account.pkcs8);
  }

  /**
   * Gives everyone who should hold an interview's key a grant: the owner's
   * own keys (and linked accounts'), and the assignee's. Only a client
   * holding the key can, so the owner's pages do it when they open.
   */
  async shareKey(
    token: string,
    session: {
      kid: string | null;
      grants?: string[] | undefined;
      assignee: string | null;
      respondent?: boolean | undefined;
    },
  ): Promise<void> {
    if (!session.kid || session.respondent || !(await this.ready())) return;
    const key = await this.keyring.get(session.kid);
    if (!key) return;
    type Listed = { fp: string; publicKey: PublicKey };
    const own = await getJson<{ keys: Listed[] }>("/api/browser/pubkeys");
    const theirs = session.assignee
      ? await getJson<{ keys: Listed[] }>(
          `/api/browser/pubkeys?email=${encodeURIComponent(session.assignee)}`,
        ).catch(() => ({ keys: [] as Listed[] }))
      : { keys: [] as Listed[] };
    const have = new Set(session.grants ?? []);
    const wanted = [
      ...own.keys.map((listed) => ({ ...listed, role: "owner" })),
      ...theirs.keys.map((listed) => ({ ...listed, role: "assignee" })),
    ].filter((listed) => !have.has(listed.fp));
    if (!wanted.length) return;
    await postJson(`/api/browser/${token}/grants`, {
      grants: await Promise.all(
        wanted.map(async (listed) => ({
          fp: listed.fp,
          role: listed.role,
          wrapped: await grantFor(listed.publicKey, key),
        })),
      ),
    });
  }

  /** Grants for an assignee about to be given an interview, from its key. */
  async assigneeGrants(
    kid: string | null,
    email: string,
  ): Promise<Array<{ fp: string; wrapped: string }> | undefined> {
    if (!kid) return undefined;
    const key = await this.keyring.get(kid);
    if (!key) throw new Error("Unlock this interview on this device first");
    const { keys } = await getJson<{
      keys: Array<{ fp: string; publicKey: PublicKey }>;
    }>(`/api/browser/pubkeys?email=${encodeURIComponent(email)}`);
    return Promise.all(
      keys.map(async (listed) => ({
        fp: listed.fp,
        wrapped: await grantFor(listed.publicKey, key),
      })),
    );
  }
}

export const encryption = new BrowserEncryption();

/** The open interview's key id, for what seals or frames its content; null when plain. */
export const KidContext = createContext<string | null>(null);

export function useEncryption(): EncryptionState {
  return useSyncExternalStore(encryption.subscribe, encryption.snapshot);
}
