import { useCallback, useEffect, useState } from "react";
import type { PrCheck } from "../../../shared/github.js";

/** A GitHub-backed request: loading, loaded, needing the token, or failed. */
export type Loaded<T> =
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "setup" }
  | { status: "error"; error: string };

const BASE = "/api/browser/kim";

/** Calls a Keep it moving browser route; a 503 means GITHUB_TOKEN isn't set. */
export async function kimFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<Loaded<T>> {
  const response = await fetch(`${BASE}${path}`, init).catch(() => null);
  if (!response) return { status: "error", error: "Couldn't reach the server" };
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (response.status === 503) return { status: "setup" };
  if (!response.ok)
    return {
      status: "error",
      error: body.error ?? `Request failed (${response.status})`,
    };
  return { status: "ok", data: body };
}

/** Loads a path, again whenever it changes; `set` replaces the data (after a sync). */
export function useKim<T>(path: string) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    void kimFetch<T>(path).then((result) => {
      if (live) setState(result);
    });
    return () => {
      live = false;
    };
  }, [path]);
  const set = useCallback((result: Loaded<T>) => setState(result), []);
  return [state, set] as const;
}

/**
 * Client-side navigation. Assumes the shell re-renders on popstate, so it
 * pushes the URL and then fires one.
 */
export function navigate(href: string): void {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export const prHref = (projectId: string, number: number) =>
  `/p/${encodeURIComponent(projectId)}/pr/${number}`;

/** One check's dot colour class. */
export function checkTone(
  check: PrCheck,
): "green" | "red" | "pending" | "grey" {
  if (check.status !== "completed") return "pending";
  if (check.conclusion === "success") return "green";
  if (
    [
      "failure",
      "timed_out",
      "cancelled",
      "action_required",
      "startup_failure",
    ].includes(check.conclusion ?? "")
  )
    return "red";
  return "grey";
}

/** "4m", "3h", "2d": how long ago an ISO time was. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}
