import { createContext, useContext, useEffect, useState } from "react";

/**
 * Bumps whenever the server says something changed (the /ws/overview ping),
 * so every fetch in the shell refetches. Features read it with useLive().
 */
export const LiveVersion = createContext(0);

export const useLive = () => useContext(LiveVersion);

/** Counts the server's overview pings, reconnecting when the socket drops. */
export function useOverviewSocket(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`${protocol}//${location.host}/ws/overview`);
      socket.onmessage = () => setVersion((value) => value + 1);
      // Catch up on whatever changed while it was down.
      socket.onopen = () => setVersion((value) => value + 1);
      socket.onclose = () => {
        if (!disposed) timer = setTimeout(connect, 2_000);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, []);
  return version;
}

/**
 * JSON from a GET, refetched when the live version (or the URL) changes.
 * Keeps the last good value while refetching; null until the first load.
 */
export function useJson<T>(url: string | null): {
  data: T | null;
  error: string;
  reload: () => void;
} {
  const live = useLive();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!url) return;
    let current = true;
    void (async () => {
      try {
        const response = await fetch(url);
        const body = (await response.json()) as T & { error?: string };
        if (!current) return;
        if (!response.ok) setError(body.error ?? `HTTP ${response.status}`);
        else {
          setData(body);
          setError("");
        }
      } catch (failure) {
        if (current)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      }
    })();
    return () => {
      current = false;
    };
  }, [url, live, nonce]);
  useEffect(() => setData(null), [url]);
  return { data, error, reload: () => setNonce((value) => value + 1) };
}

/** "4m", "2h", "3d": how long something has been waiting. */
export function age(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}
