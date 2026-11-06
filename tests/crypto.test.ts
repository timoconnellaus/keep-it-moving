import { describe, expect, it } from "vitest";
import {
  importAccountKey,
  isSealed,
  Keyring,
  LOCKED,
  lockAccountKey,
  newAccountKey,
  newInterviewKey,
  newRecoveryCode,
  newSalt,
  open,
  openGrant,
  grantFor,
  parseRecoveryCode,
  seal,
  unlockAccountKey,
  unsealDeep,
} from "../src/shared/crypto.js";

describe("sealed fields", () => {
  it("round-trips short and long text, compressing the long", async () => {
    const key = await newInterviewKey();
    const short = await seal(key, "Which layout?");
    expect(isSealed(short, key.kid)).toBe(true);
    expect(short).not.toContain("layout");
    expect(await open(key, short)).toBe("Which layout?");
    const html = `<!doctype html>${"<p>Hello, world</p>".repeat(2_000)}`;
    const long = await seal(key, html);
    expect(long.length).toBeLessThan(html.length / 4);
    expect(await open(key, long)).toBe(html);
  });

  it("refuses another interview's key and a tampered field", async () => {
    const [a, b] = [await newInterviewKey(), await newInterviewKey()];
    const sealed = await seal(a, "secret");
    await expect(open(b, sealed)).rejects.toThrow();
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA");
    await expect(open(a, tampered)).rejects.toThrow();
  });

  it("seals the same text differently every time", async () => {
    const key = await newInterviewKey();
    expect(await seal(key, "Yes")).not.toBe(await seal(key, "Yes"));
  });
});

describe("grants and account keys", () => {
  it("wraps an interview key to a member, who alone can open it", async () => {
    const [ann, bob] = [await newAccountKey(), await newAccountKey()];
    const key = await newInterviewKey();
    const grant = await grantFor(bob.publicKey, key);
    const opened = await openGrant(bob, key.kid, grant);
    expect(await open(opened, await seal(key, "hi"))).toBe("hi");
    await expect(openGrant(ann, key.kid, grant)).rejects.toThrow();
  });

  it("unlocks the account key with a recovery code, however it's typed", async () => {
    const account = await newAccountKey();
    const { code, secret } = newRecoveryCode();
    expect(code).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    const salt = newSalt();
    const wrapped = await lockAccountKey(account, "recovery", secret, salt);
    const unlock = {
      method: "recovery" as const,
      salt: Buffer.from(salt).toString("base64url"),
      wrapped,
    };
    const typed = code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o");
    const back = await unlockAccountKey(unlock, parseRecoveryCode(typed));
    expect(back.fingerprint).toBe(account.fingerprint);
    const wrong = newRecoveryCode();
    await expect(unlockAccountKey(unlock, wrong.secret)).rejects.toThrow(
      /recovery code doesn't unlock/,
    );
  });

  it("keeps the same fingerprint through PKCS #8", async () => {
    const account = await newAccountKey();
    expect((await importAccountKey(account.pkcs8)).fingerprint).toBe(
      account.fingerprint,
    );
  });
});

describe("unsealDeep", () => {
  it("opens fields, object keys and composed messages, and locks the rest", async () => {
    const mine = await newInterviewKey();
    const theirs = await newInterviewKey();
    const option = await seal(mine, "Serif");
    let asked = 0;
    const ring = new Keyring(async (kids) => {
      asked++;
      return kids.map((kid) => (kid === mine.kid ? mine : null));
    });
    const value = {
      title: await seal(mine, "Venue survey"),
      options: [option],
      optionValues: { [option]: { "--font": await seal(mine, "Fraunces") } },
      error: `Default "${await seal(mine, "Sans")}" is not one of the options`,
      other: await seal(theirs, "not yours"),
      count: 3,
    };
    expect(await unsealDeep(value, ring)).toEqual({
      title: "Venue survey",
      options: ["Serif"],
      optionValues: { Serif: { "--font": "Fraunces" } },
      error: 'Default "Sans" is not one of the options',
      other: LOCKED,
      count: 3,
    });
    expect(asked).toBe(1);
  });
});
