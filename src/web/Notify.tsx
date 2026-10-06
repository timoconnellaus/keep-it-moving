import { useEffect, useState } from "react";

type NotifyState = "unsupported" | "off" | "on" | "blocked" | "working";

const supported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

/** VAPID keys travel as base64url; PushManager wants the raw bytes. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      ((await response.json().catch(() => ({}))) as { error?: string }).error ??
        `HTTP ${response.status}`,
    );
}

/**
 * Turns push notifications on for this device, so an interview that starts
 * waiting on the user reaches their phone.
 */
export function NotifyToggle() {
  const [state, setState] = useState<NotifyState>(
    supported() ? "working" : "unsupported",
  );
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supported()) return;
    void (async () => {
      if (Notification.permission === "denied") return setState("blocked");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      setState(subscription ? "on" : "off");
    })();
  }, []);

  if (state === "unsupported") return null;

  const turnOn = async () => {
    setState("working");
    setError("");
    try {
      const { publicKey } = (await (
        await fetch("/api/browser/push/key")
      ).json()) as { publicKey: string | null };
      if (!publicKey)
        throw new Error("Notifications aren't set up on the server");
      if ((await Notification.requestPermission()) !== "granted")
        return setState("blocked");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      });
      await post("/api/browser/push/subscribe", {
        endpoint: subscription.endpoint,
      });
      setState("on");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setState("off");
    }
  };
  const turnOff = async () => {
    setState("working");
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await post("/api/browser/push/unsubscribe", {
        endpoint: subscription.endpoint,
      }).catch(() => undefined);
      await subscription.unsubscribe();
    }
    setState("off");
  };
  const test = async () => {
    setError("");
    await post("/api/browser/push/test", {}).catch((failure: Error) =>
      setError(failure.message),
    );
  };

  return (
    <span className="notify">
      {state === "on" ? (
        <>
          <button
            type="button"
            className="notify-button on"
            aria-pressed="true"
            onClick={() => void turnOff()}
          >
            <BellIcon /> Notifications on
          </button>
          <button
            type="button"
            className="notify-test"
            onClick={() => void test()}
          >
            Send a test
          </button>
        </>
      ) : state === "blocked" ? (
        <span className="notify-blocked">
          Notifications are blocked in this browser's site settings
        </span>
      ) : (
        <button
          type="button"
          className="notify-button"
          aria-pressed="false"
          disabled={state === "working"}
          onClick={() => void turnOn()}
        >
          <BellIcon /> Notify me
        </button>
      )}
      {error && (
        <span className="notify-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function BellIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
