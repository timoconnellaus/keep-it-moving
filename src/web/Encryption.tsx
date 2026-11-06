import { useEffect, useState, useSyncExternalStore } from "react";
import type { AccountKey, PublicKey, Unlock } from "../shared/crypto.js";
import { encryption, useEncryption } from "./keys.js";
import { Logo } from "./Logo.js";

/**
 * Setting up and unlocking end-to-end encryption: one dialog the whole
 * page shares, a banner on the home page while it's off or locked, its
 * place in the account menu, and the page `kim login` hands the key over
 * from.
 */

type DialogMode = "setup" | "unlock" | "reset";

// One dialog for the page, so a menu that closes doesn't take it with it.
let dialog: DialogMode | null = null;
const dialogListeners = new Set<() => void>();
export function openEncryption(mode: DialogMode | null) {
  dialog = mode;
  for (const listener of dialogListeners) listener();
}
const useDialog = () =>
  useSyncExternalStore(
    (listener) => {
      dialogListeners.add(listener);
      return () => dialogListeners.delete(listener);
    },
    () => dialog,
  );

/** Where the dialog shows; mount once per page. */
export function EncryptionDialogHost() {
  const mode = useDialog();
  if (!mode) return null;
  const close = () => openEncryption(null);
  return (
    <div
      className="e2e-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="e2e-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="e2e-title"
      >
        {mode === "setup" && <Setup onDone={close} onCancel={close} />}
        {mode === "unlock" && <UnlockPanel onDone={close} onCancel={close} />}
        {mode === "reset" && <Reset onDone={close} onCancel={close} />}
      </div>
    </div>
  );
}

function Setup({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel?: (() => void) | undefined;
}) {
  const [step, setStep] = useState<"intro" | "passkey" | "code" | "saving">(
    "intro",
  );
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<{
    account: AccountKey;
    code: string;
    unlock: Unlock;
  } | null>(null);
  const [passkey, setPasskey] = useState<Unlock | null | "none">(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const state = useEncryption();

  const makePasskey = async () => {
    setError("");
    setStep("passkey");
    try {
      const ready = prepared ?? (await encryption.prepareSetup());
      setPrepared(ready);
      const made = state.passkeys
        ? await encryption.passkeyFor(ready.account)
        : null;
      setPasskey(made ?? "none");
      setStep("code");
    } catch (failure) {
      setError(
        failure instanceof Error && failure.name === "NotAllowedError"
          ? "The passkey wasn't made. Try again, or carry on with only a recovery code."
          : `Couldn't make a passkey: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      setStep("intro");
    }
  };
  const codeOnly = async () => {
    setError("");
    const ready = prepared ?? (await encryption.prepareSetup());
    setPrepared(ready);
    setPasskey("none");
    setStep("code");
  };
  const finish = async () => {
    if (!prepared) return;
    setStep("saving");
    setError("");
    try {
      await encryption.finishSetup(prepared.account, [
        ...(passkey && passkey !== "none" ? [passkey] : []),
        prepared.unlock,
      ]);
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setStep("code");
    }
  };
  const download = () => {
    if (!prepared) return;
    const blob = new Blob(
      [
        `Keep it moving recovery code for ${state.email ?? "your account"}\n\n${prepared.code}\n\nIt unlocks your end-to-end encrypted interviews on a new device. Keep it somewhere safe and private.\n`,
      ],
      { type: "text/plain" },
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "keep-it-moving-recovery-code.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  if (step === "intro" || step === "passkey")
    return (
      <>
        <LockMark />
        <h2 id="e2e-title">Turn on end-to-end encryption</h2>
        <p>
          New interviews&rsquo; questions, answers, chat and mockups are
          encrypted on your devices before they reach us. Our servers only ever
          hold ciphertext.
        </p>
        <ul className="e2e-points">
          <li>
            A <b>passkey</b> unlocks your interviews on your other devices.
          </li>
          <li>
            A <b>recovery code</b> is the backup if you lose your passkey.
          </li>
          <li>
            Lose both, and your encrypted interviews can&rsquo;t be recovered,
            by you or by us.
          </li>
        </ul>
        {error && <p className="e2e-error">{error}</p>}
        <div className="e2e-actions">
          {onCancel && (
            <button type="button" onClick={onCancel}>
              Not now
            </button>
          )}
          {error && (
            <button type="button" onClick={() => void codeOnly()}>
              Use only a recovery code
            </button>
          )}
          <button
            type="button"
            className="primary"
            disabled={step === "passkey"}
            onClick={() => void (state.passkeys ? makePasskey() : codeOnly())}
          >
            {step === "passkey"
              ? "Waiting for the passkey…"
              : state.passkeys
                ? "Make a passkey"
                : "Continue"}
          </button>
        </div>
      </>
    );
  return (
    <>
      <LockMark />
      <h2 id="e2e-title">Save your recovery code</h2>
      {passkey === "none" ? (
        <p>
          This browser can&rsquo;t unlock with a passkey, so this code is how
          you&rsquo;ll unlock your interviews on another device.
        </p>
      ) : (
        <p>
          Your passkey is ready. If you ever lose it, this code is the only
          other way in. We can&rsquo;t show it again.
        </p>
      )}
      <code className="e2e-code" aria-label="Recovery code">
        {prepared?.code}
      </code>
      <div className="e2e-row">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(prepared?.code ?? "")
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1_500);
              })
              .catch(() => undefined);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={download}>
          Download
        </button>
      </div>
      <label className="e2e-check">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        I&rsquo;ve saved it somewhere safe
      </label>
      {error && <p className="e2e-error">{error}</p>}
      <div className="e2e-actions">
        <button
          type="button"
          className="primary"
          disabled={!saved || step === "saving"}
          onClick={() => void finish()}
        >
          {step === "saving" ? "Turning on…" : "Turn on encryption"}
        </button>
      </div>
    </>
  );
}

function UnlockPanel({
  onDone,
  onCancel,
  intro,
}: {
  onDone: () => void;
  onCancel?: (() => void) | undefined;
  intro?: string;
}) {
  const state = useEncryption();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const hasPasskey = Boolean(
    state.server?.unlocks.some((unlock) => unlock.method === "passkey"),
  );
  const attempt = async (how: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await how();
      onDone();
    } catch (failure) {
      setError(
        failure instanceof Error && failure.name === "NotAllowedError"
          ? "The passkey wasn't used. Try again, or use your recovery code."
          : failure instanceof Error
            ? failure.message
            : String(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <LockMark />
      <h2 id="e2e-title">Unlock your interviews</h2>
      <p>
        {intro ??
          "Your interviews are end-to-end encrypted, and this browser hasn't been unlocked yet."}
      </p>
      {hasPasskey && state.passkeys && (
        <button
          type="button"
          className="primary e2e-wide"
          disabled={busy}
          onClick={() => void attempt(() => encryption.unlockWithPasskey())}
        >
          Unlock with your passkey
        </button>
      )}
      <form
        className="e2e-form"
        onSubmit={(event) => {
          event.preventDefault();
          void attempt(() => encryption.unlockWithCode(code));
        }}
      >
        <label>
          {hasPasskey ? "Or use your recovery code" : "Your recovery code"}
          <input
            value={code}
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            onChange={(event) => setCode(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || !code.trim()}>
          Unlock
        </button>
      </form>
      {error && <p className="e2e-error">{error}</p>}
      <div className="e2e-actions">
        <button
          type="button"
          className="e2e-quiet"
          onClick={() => openEncryption("reset")}
        >
          Lost both?
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Not now
          </button>
        )}
      </div>
    </>
  );
}

function Reset({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  return (
    <>
      <LockMark />
      <h2 id="e2e-title">Start encryption over?</h2>
      <p>
        Without your passkey or recovery code, nobody can open your encrypted
        interviews: not you, and not us. Starting over gives you a new key for
        new interviews. The old ones stay, but can&rsquo;t be read again.
      </p>
      <form
        className="e2e-form"
        onSubmit={(event) => {
          event.preventDefault();
          void encryption
            .reset()
            .then(() => openEncryption("setup"))
            .catch((failure: Error) => setError(failure.message));
        }}
      >
        <label>
          Type <b>start over</b> to confirm
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="danger"
          disabled={typed.trim().toLowerCase() !== "start over"}
        >
          Start over
        </button>
      </form>
      {error && <p className="e2e-error">{error}</p>}
      <div className="e2e-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="e2e-quiet" onClick={onDone}>
          Close
        </button>
      </div>
    </>
  );
}

function LockMark() {
  return (
    <svg
      className="e2e-mark"
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** On the home page: while encryption is off, or this browser is locked. */
export function EncryptionBanner() {
  const state = useEncryption();
  if (state.status === "off")
    return (
      <div className="e2e-banner">
        <LockMark />
        <span>
          <b>Turn on end-to-end encryption.</b> New interviews are encrypted on
          your devices, and we only ever see ciphertext.
        </span>
        <button type="button" onClick={() => openEncryption("setup")}>
          Turn on
        </button>
      </div>
    );
  if (state.status === "locked")
    return (
      <div className="e2e-banner">
        <LockMark />
        <span>
          <b>This browser is locked.</b> Unlock it to read your encrypted
          interviews.
        </span>
        <button type="button" onClick={() => openEncryption("unlock")}>
          Unlock
        </button>
      </div>
    );
  return null;
}

/** The account menu's encryption section. */
export function EncryptionMenu({ onAction }: { onAction: () => void }) {
  const state = useEncryption();
  const [note, setNote] = useState("");
  if (state.status === "loading") return null;
  const act = (run: () => void) => () => {
    onAction();
    run();
  };
  return (
    <div className="account-encryption">
      <span className="account-links-head">
        End-to-end encryption:{" "}
        {state.status === "off"
          ? "off"
          : state.status === "locked"
            ? "on, locked here"
            : "on"}
      </span>
      {state.status === "off" && (
        <button
          type="button"
          role="menuitem"
          onClick={act(() => openEncryption("setup"))}
        >
          Turn on encryption
        </button>
      )}
      {state.status === "locked" && (
        <button
          type="button"
          role="menuitem"
          onClick={act(() => openEncryption("unlock"))}
        >
          Unlock this browser
        </button>
      )}
      {state.status === "unlocked" && (
        <>
          {state.passkeys && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setNote("");
                void encryption
                  .addPasskey()
                  .then((added) =>
                    setNote(
                      added
                        ? "Passkey added."
                        : "This browser can't make a passkey that unlocks encryption.",
                    ),
                  )
                  .catch((failure: Error) =>
                    setNote(
                      failure.name === "NotAllowedError"
                        ? "No passkey was made."
                        : failure.message,
                    ),
                  );
              }}
            >
              Add a passkey
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={act(() => void encryption.lock())}
          >
            Lock this browser
          </button>
        </>
      )}
      {note && <span role="status">{note}</span>}
    </div>
  );
}

/**
 * `/cli-key`: where `kim login` sends the browser after signing in. It
 * wraps the account's key to the CLI's one-off public key and hands it to
 * the CLI's loopback server, so it never passes through the service.
 */
export function CliKey() {
  const state = useEncryption();
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const params = new URLSearchParams(location.hash.slice(1));
  const port = params.get("port") ?? "";
  const handoff = params.get("state") ?? "";
  const [x, y] = (params.get("pub") ?? "").split(".");
  const valid =
    /^\d{2,5}$/.test(port) &&
    /^[A-Za-z0-9_-]{8,64}$/.test(handoff) &&
    /^[A-Za-z0-9_-]{43}$/.test(x ?? "") &&
    /^[A-Za-z0-9_-]{43}$/.test(y ?? "");
  const back = (query: Record<string, string>) => {
    location.href = `http://127.0.0.1:${port}/key?${new URLSearchParams({
      state: handoff,
      ...query,
    })}`;
  };
  useEffect(() => {
    if (!valid || state.status !== "unlocked" || sent) return;
    setSent(true);
    const cli: PublicKey = { kty: "EC", crv: "P-256", x: x!, y: y! };
    void encryption
      .wrapForCli(cli)
      .then((wrapped) => back({ w: wrapped }))
      .catch((failure: Error) => setError(failure.message));
  }, [state.status, valid, sent]);

  return (
    <div className="home-page">
      <main className="cli-key">
        <div className="e2e-dialog e2e-page">
          {!valid ? (
            <>
              <Logo size={28} />
              <h2 id="e2e-title">This link is incomplete</h2>
              <p>Run `kim login` again from your terminal.</p>
            </>
          ) : state.status === "loading" || state.status === "unlocked" ? (
            <>
              <Logo size={28} />
              <h2 id="e2e-title">
                {error ? "Couldn't hand over your key" : "Signing in kim…"}
              </h2>
              <p>
                {error ||
                  "Handing your encryption key to the kim CLI on this computer."}
              </p>
            </>
          ) : state.status === "locked" ? (
            <UnlockPanel
              intro="kim is signing in. Unlock your encryption key on this browser to give the CLI a copy."
              onDone={() => undefined}
              onCancel={() => back({ skip: "1" })}
            />
          ) : (
            <Setup
              onDone={() => undefined}
              onCancel={() => back({ skip: "1" })}
            />
          )}
          {error && (
            <div className="e2e-actions">
              <button type="button" onClick={() => back({ skip: "1" })}>
                Continue without it
              </button>
            </div>
          )}
        </div>
      </main>
      <EncryptionDialogHost />
    </div>
  );
}
