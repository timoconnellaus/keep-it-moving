/**
 * End-to-end encryption, the same in the browser, the CLI and tests (Web
 * Crypto). The service stores and relays what these make and can read
 * none of it.
 *
 * - Each interview has its own AES-256-GCM key, named by a short random
 *   key id. Every content field is a sealed envelope, `kim1.<kid>.<data>`:
 *   a flag byte (1 when the text was gzipped first), then the text, under
 *   a fresh IV, with the key id as associated data.
 * - Each user has an ECDH P-256 key pair. An interview's key reaches a
 *   member wrapped to their public key (ephemeral ECDH, HKDF-SHA-256,
 *   AES-GCM): a grant.
 * - The private key is kept on the service only wrapped: under a passkey's
 *   PRF output, or under the recovery code shown once at setup.
 */

/**
 * The parts of Web Crypto used here, typed once: the DOM, Node and the
 * Workers runtime each describe it a little differently.
 */
interface Subtle {
  importKey(
    format: string,
    data: unknown,
    algorithm: unknown,
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKey>;
  exportKey(format: "jwk", key: CryptoKey): Promise<Jwk>;
  exportKey(format: "raw" | "pkcs8", key: CryptoKey): Promise<ArrayBuffer>;
  generateKey(
    algorithm: unknown,
    extractable: boolean,
    usages: string[],
  ): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }>;
  encrypt(
    algorithm: unknown,
    key: CryptoKey,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  decrypt(
    algorithm: unknown,
    key: CryptoKey,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  deriveBits(
    algorithm: unknown,
    key: CryptoKey,
    length: number,
  ): Promise<ArrayBuffer>;
  deriveKey(
    algorithm: unknown,
    base: CryptoKey,
    derived: unknown,
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKey>;
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}
const subtle = () => crypto.subtle as unknown as Subtle;
/** A JSON Web Key, as much of one as is read here. */
interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  [field: string]: unknown;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A sealed field anywhere in a string: its key id, then its data. */
export const ENVELOPE = /kim1\.([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{24,})/g;
/** A whole string that is one sealed field. */
const WHOLE_ENVELOPE = /^kim1\.([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{24,})$/;
/** Shown in place of a field this client has no key for. */
export const LOCKED = "🔒 Encrypted";

/** Text over this many bytes is gzipped before sealing, when that helps. */
const COMPRESS_OVER = 1_024;

export const isSealed = (value: unknown, kid?: string): value is string => {
  if (typeof value !== "string") return false;
  const match = WHOLE_ENVELOPE.exec(value);
  return Boolean(match && (kid === undefined || match[1] === kid));
};

/** The key id of a sealed field, or null. */
export const sealedKid = (value: string): string | null =>
  WHOLE_ENVELOPE.exec(value)?.[1] ?? null;

// ---------------------------------------------------------------- encoding

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const random = (length: number) =>
  crypto.getRandomValues(new Uint8Array(length));

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function streamThrough(
  bytes: Uint8Array<ArrayBuffer>,
  transform: { readable: ReadableStream; writable: WritableStream },
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = transform.writable.getWriter();
  void writer.write(bytes).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = transform.readable.getReader();
  for (;;) {
    const { done, value } = (await reader.read()) as {
      done: boolean;
      value?: Uint8Array;
    };
    if (done) break;
    chunks.push(value!);
  }
  return concat(...chunks);
}

const canCompress = () =>
  typeof CompressionStream !== "undefined" &&
  typeof DecompressionStream !== "undefined";

// ---------------------------------------------------------- interview keys

export interface InterviewKey {
  kid: string;
  key: CryptoKey;
  /** The key's bytes, to wrap for members. */
  raw: Uint8Array<ArrayBuffer>;
}

export async function importInterviewKey(
  kid: string,
  raw: Uint8Array<ArrayBuffer>,
): Promise<InterviewKey> {
  if (raw.length !== 32) throw new Error("An interview key is 32 bytes");
  const key = await subtle().importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return { kid, key, raw };
}

export const newInterviewKey = () =>
  importInterviewKey(toBase64Url(random(8)), random(32));

/** Seals one field under an interview's key. */
export async function seal(key: InterviewKey, text: string): Promise<string> {
  let body = new Uint8Array(encoder.encode(text));
  let flag = 0;
  if (body.length > COMPRESS_OVER && canCompress()) {
    const zipped = await streamThrough(body, new CompressionStream("gzip"));
    if (zipped.length < body.length) {
      body = zipped;
      flag = 1;
    }
  }
  const iv = random(12);
  const sealed = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(key.kid) },
    key.key,
    concat(new Uint8Array([flag]), body),
  );
  return `kim1.${key.kid}.${toBase64Url(concat(iv, new Uint8Array(sealed)))}`;
}

/** Opens a sealed field; throws when the key is wrong or it was changed. */
export async function open(
  key: InterviewKey,
  envelope: string,
): Promise<string> {
  const match = WHOLE_ENVELOPE.exec(envelope);
  if (!match || match[1] !== key.kid)
    throw new Error("Not sealed with this key");
  const data = fromBase64Url(match[2]!);
  const plain = new Uint8Array(
    await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: data.subarray(0, 12),
        additionalData: encoder.encode(key.kid),
      },
      key.key,
      data.subarray(12),
    ),
  );
  const body = plain.subarray(1);
  if (plain[0] === 0) return decoder.decode(body);
  if (plain[0] !== 1) throw new Error("Unknown envelope format");
  if (!canCompress()) throw new Error("This runtime can't decompress");
  return decoder.decode(
    await streamThrough(new Uint8Array(body), new DecompressionStream("gzip")),
  );
}

// ------------------------------------------------------------ account keys

/** A public key, as the service keeps it and the directory hands it out. */
export interface PublicKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface AccountKey {
  privateKey: CryptoKey;
  publicKey: PublicKey;
  /** Short, stable name for the public key: grants are addressed to it. */
  fingerprint: string;
  /** The private key's PKCS #8 bytes, to wrap, hand to the CLI, or store. */
  pkcs8: Uint8Array<ArrayBuffer>;
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export async function fingerprint(publicKey: PublicKey): Promise<string> {
  const digest = await subtle().digest(
    "SHA-256",
    encoder.encode(`${publicKey.crv}.${publicKey.x}.${publicKey.y}`),
  );
  return toBase64Url(new Uint8Array(digest)).slice(0, 16);
}

const publicPart = (jwk: Jwk): PublicKey => {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y)
    throw new Error("Not a P-256 public key");
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
};

export function isPublicKey(value: unknown): value is PublicKey {
  try {
    publicPart(value as Jwk);
    const { x, y } = value as PublicKey;
    return /^[A-Za-z0-9_-]{43}$/.test(x) && /^[A-Za-z0-9_-]{43}$/.test(y);
  } catch {
    return false;
  }
}

/** An account key from its PKCS #8 bytes: as the CLI keeps it. */
export async function importAccountKey(
  pkcs8: Uint8Array<ArrayBuffer>,
): Promise<AccountKey> {
  const privateKey = await subtle().importKey("pkcs8", pkcs8, ECDH, true, [
    "deriveBits",
  ]);
  const publicKey = publicPart(await subtle().exportKey("jwk", privateKey));
  return {
    privateKey,
    publicKey,
    fingerprint: await fingerprint(publicKey),
    pkcs8,
  };
}

export async function newAccountKey(): Promise<AccountKey> {
  const pair = await subtle().generateKey(ECDH, true, ["deriveBits"]);
  return importAccountKey(
    new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey)),
  );
}

/** HKDF-SHA-256 to an AES-GCM key. */
async function derive(
  secret: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: string,
): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", secret, "HKDF", false, [
    "deriveKey",
  ]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function aesSeal(key: CryptoKey, plain: Uint8Array<ArrayBuffer>) {
  const iv = random(12);
  const sealed = await subtle().encrypt({ name: "AES-GCM", iv }, key, plain);
  return concat(iv, new Uint8Array(sealed));
}

async function aesOpen(key: CryptoKey, data: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(
    await subtle().decrypt(
      { name: "AES-GCM", iv: data.subarray(0, 12) },
      key,
      data.subarray(12),
    ),
  );
}

/** Wraps bytes (an interview key, an account key) to someone's public key. */
export async function wrapTo(
  recipient: PublicKey,
  secret: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const them = await subtle().importKey("jwk", recipient, ECDH, false, []);
  const ephemeral = await subtle().generateKey(ECDH, true, ["deriveBits"]);
  const shared = new Uint8Array(
    await subtle().deriveBits(
      { name: "ECDH", public: them },
      ephemeral.privateKey,
      256,
    ),
  );
  const ephemeralRaw = new Uint8Array(
    await subtle().exportKey("raw", ephemeral.publicKey),
  );
  const key = await derive(shared, ephemeralRaw, "kim1 wrap");
  return `w1.${toBase64Url(ephemeralRaw)}.${toBase64Url(await aesSeal(key, secret))}`;
}

export async function unwrapWith(
  privateKey: CryptoKey,
  wrapped: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const [version, ephemeral, data] = wrapped.split(".");
  if (version !== "w1" || !ephemeral || !data)
    throw new Error("Not a wrapped key");
  const ephemeralRaw = fromBase64Url(ephemeral);
  const them = await subtle().importKey("raw", ephemeralRaw, ECDH, false, []);
  const shared = new Uint8Array(
    await subtle().deriveBits({ name: "ECDH", public: them }, privateKey, 256),
  );
  const key = await derive(shared, ephemeralRaw, "kim1 wrap");
  return aesOpen(key, fromBase64Url(data));
}

/** An interview key for one member: wrapped to their public key. */
export const grantFor = (recipient: PublicKey, key: InterviewKey) =>
  wrapTo(recipient, key.raw);

export async function openGrant(
  account: Pick<AccountKey, "privateKey">,
  kid: string,
  wrapped: string,
): Promise<InterviewKey> {
  return importInterviewKey(kid, await unwrapWith(account.privateKey, wrapped));
}

// ------------------------------------------------------- unlocking a device

/** How a device unlocks the account's private key, as the service keeps it. */
export interface Unlock {
  id: string;
  method: "passkey" | "recovery";
  /** For a passkey: its credential id (base64url). */
  credentialId?: string;
  /** The PRF salt or the recovery code's HKDF salt (base64url). */
  salt: string;
  /** The private key's PKCS #8 bytes, sealed under the unlock secret. */
  wrapped: string;
  label?: string;
  createdAt?: string;
}

const UNLOCK_INFO = {
  passkey: "kim1 unlock passkey",
  recovery: "kim1 unlock recovery",
} as const;

/** Seals the account's private key under a passkey's PRF output or a recovery code. */
export async function lockAccountKey(
  account: AccountKey,
  method: Unlock["method"],
  secret: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const key = await derive(secret, salt, UNLOCK_INFO[method]);
  return toBase64Url(await aesSeal(key, account.pkcs8));
}

export async function unlockAccountKey(
  unlock: Pick<Unlock, "method" | "salt" | "wrapped">,
  secret: Uint8Array<ArrayBuffer>,
): Promise<AccountKey> {
  const key = await derive(
    secret,
    fromBase64Url(unlock.salt),
    UNLOCK_INFO[unlock.method],
  );
  let pkcs8: Uint8Array<ArrayBuffer>;
  try {
    pkcs8 = await aesOpen(key, fromBase64Url(unlock.wrapped));
  } catch {
    throw new Error(
      unlock.method === "recovery"
        ? "That recovery code doesn't unlock this account"
        : "That passkey doesn't unlock this account",
    );
  }
  return importAccountKey(pkcs8);
}

export const newSalt = () => random(32);

// ----------------------------------------------------------- recovery codes

/** Crockford's base32: no I, L, O or U, so it reads aloud and types cleanly. */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 160 random bits, as 8 groups of 4 characters. */
export function newRecoveryCode(): {
  code: string;
  secret: Uint8Array<ArrayBuffer>;
} {
  const secret = random(20);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of secret) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return { code: out.match(/.{4}/g)!.join("-"), secret };
}

/** The secret a recovery code stands for, however it was typed. */
export function parseRecoveryCode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (!/^[0-9A-HJKMNP-TV-Z]{32}$/.test(clean))
    throw new Error("A recovery code is 32 letters and digits");
  const out = new Uint8Array(20);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

// ---------------------------------------------------------------- keyrings

/**
 * The interview keys a client holds, found on demand: `resolve` fetches
 * and opens the grants for key ids it hasn't seen.
 */
export class Keyring {
  private readonly keys = new Map<string, InterviewKey | null>();
  constructor(
    private readonly resolve: (
      kids: string[],
    ) => Promise<Array<InterviewKey | null>>,
  ) {}

  add(key: InterviewKey): void {
    this.keys.set(key.kid, key);
  }

  has(kid: string): boolean {
    return Boolean(this.keys.get(kid));
  }

  async get(kid: string): Promise<InterviewKey | null> {
    await this.load([kid]);
    return this.keys.get(kid) ?? null;
  }

  /** Fetches what isn't known yet; a key that can't be had stays null. */
  async load(kids: Iterable<string>): Promise<void> {
    const missing = [...new Set(kids)].filter((kid) => !this.keys.has(kid));
    if (!missing.length) return;
    let found: Array<InterviewKey | null>;
    try {
      found = await this.resolve(missing);
    } catch {
      found = [];
    }
    missing.forEach((kid, index) => {
      const key = found[index] ?? found.find((item) => item?.kid === kid);
      // A miss isn't remembered: the grant may arrive later.
      if (key) this.keys.set(kid, key);
    });
  }

  known(kid: string): InterviewKey | undefined {
    return this.keys.get(kid) ?? undefined;
  }
}

/** Every key id sealed anywhere in a value: strings, and object keys. */
export function kidsIn(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(ENVELOPE)) into.add(match[1]!);
  } else if (Array.isArray(value)) for (const item of value) kidsIn(item, into);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      kidsIn(key, into);
      kidsIn(item, into);
    }
  return into;
}

function envelopesIn(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(ENVELOPE)) into.add(match[0]);
  } else if (Array.isArray(value))
    for (const item of value) envelopesIn(item, into);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      envelopesIn(key, into);
      envelopesIn(item, into);
    }
  return into;
}

/**
 * The value with every sealed field opened, wherever it is: a field, part
 * of a message the service composed, or an object key. A field this
 * keyring can't open reads as LOCKED.
 */
export async function unsealDeep<T>(value: T, keyring: Keyring): Promise<T> {
  const envelopes = envelopesIn(value);
  if (!envelopes.size) return value;
  await keyring.load(kidsIn(value));
  const opened = new Map<string, string>();
  await Promise.all(
    [...envelopes].map(async (envelope) => {
      const key = keyring.known(sealedKid(envelope)!);
      opened.set(
        envelope,
        key ? await open(key, envelope).catch(() => LOCKED) : LOCKED,
      );
    }),
  );
  const replace = (text: string) =>
    text.replace(ENVELOPE, (whole) => opened.get(whole) ?? LOCKED);
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return replace(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, inner]) => [replace(key), walk(inner)]),
      );
    return item;
  };
  return walk(value) as T;
}
