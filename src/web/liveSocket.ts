/** Why a page's live updates stopped for good. */
export type LiveStop = "deleted" | "unshared" | "signed-out";

export interface LiveSocketOptions {
  url: string;
  /**
   * An HTTP request that says why a socket failed, since a browser can't
   * read a refused upgrade's status: its status, or null when unreachable.
   */
  probe: () => Promise<number | null>;
  onOpen?: () => void;
  onMessage: (data: string) => void;
  /** The socket dropped and will retry. */
  onDrop?: () => void;
  /** It won't retry: the page should say why. */
  onStop: (reason: LiveStop) => void;
}

/** Close codes and refusals that end retrying. */
const STOP_CODES: Record<number, LiveStop> = {
  1008: "unshared",
  4401: "signed-out",
  4403: "unshared",
  4404: "deleted",
};
const STOP_STATUSES: Record<number, LiveStop> = {
  401: "signed-out",
  403: "unshared",
  404: "deleted",
};

export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 60_000;

/**
 * A WebSocket that reconnects with exponential backoff and jitter, waits
 * while the tab is hidden, and stops when the server has said no for good:
 * the interview was deleted or unshared, or the user signed out. Every
 * reconnect wakes the user's Durable Object, so retrying forever every
 * second is not free. Returns a function that closes it.
 */
export function liveSocket(options: LiveSocketOptions): () => void {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let disposed = false;
  let stopped = false;

  const stop = (reason: LiveStop) => {
    stopped = true;
    options.onStop(reason);
  };
  const retry = () => {
    if (disposed || stopped) return;
    options.onDrop?.();
    // Hidden tabs wait for the user to come back.
    if (document.hidden) return;
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt++);
    timer = setTimeout(connect, ceiling / 2 + (Math.random() * ceiling) / 2);
  };
  const connect = () => {
    timer = null;
    if (disposed || stopped || document.hidden) return;
    const next = new WebSocket(options.url);
    socket = next;
    next.onopen = () => {
      attempt = 0;
      options.onOpen?.();
    };
    next.onmessage = (event: MessageEvent) =>
      options.onMessage(String(event.data));
    next.onclose = (event?: CloseEvent) => {
      if (disposed || socket !== next) return;
      socket = null;
      const known = event ? STOP_CODES[event.code] : undefined;
      if (known) return stop(known);
      void options.probe().then(
        (status) => {
          const refused = status === null ? undefined : STOP_STATUSES[status];
          if (refused) stop(refused);
          else retry();
        },
        () => retry(),
      );
    };
  };
  const onVisibility = () => {
    if (document.hidden || socket || timer || stopped || disposed) return;
    attempt = 0;
    connect();
  };

  document.addEventListener("visibilitychange", onVisibility);
  connect();
  return () => {
    disposed = true;
    document.removeEventListener("visibilitychange", onVisibility);
    if (timer) clearTimeout(timer);
    if (
      socket?.readyState === WebSocket.CONNECTING ||
      socket?.readyState === WebSocket.OPEN
    )
      socket.close();
  };
}

/** What a page says when its live updates stop. */
export const STOP_MESSAGES: Record<LiveStop, string> = {
  deleted: "This interview was deleted.",
  unshared: "This interview is no longer shared with you.",
  "signed-out": "You're signed out. Reload to sign in again.",
};

/** The status of a GET, or null when the server can't be reached. */
export const probeStatus = (url: string) => () =>
  fetch(url).then(
    (response) => response.status,
    () => null,
  );
