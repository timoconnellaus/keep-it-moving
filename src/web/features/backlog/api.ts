import { useCallback, useEffect, useState } from "react";
import type {
  FollowUpView,
  ProjectBacklogView,
} from "../../../shared/backlog.js";

const base = "/api/browser/kim";
/** Sections of one project share data: a change in one reloads the others. */
const CHANGED = "kim-backlog-changed";

export function backlogChanged(projectId: string) {
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: projectId }));
}

function useOnChange(projectId: string, load: () => unknown) {
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail === projectId) void load();
    };
    window.addEventListener(CHANGED, listener);
    return () => window.removeEventListener(CHANGED, listener);
  }, [projectId, load]);
}

/** The project's milestone, up-next list and sync state; null while loading. */
export function useProjectBacklog(projectId: string) {
  const [view, setView] = useState<ProjectBacklogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(`${base}/projects/${projectId}/backlog`).catch(
      () => null,
    );
    if (!response?.ok) {
      setError("Couldn't load the backlog");
      return;
    }
    setError(null);
    setView((await response.json()) as ProjectBacklogView);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  useOnChange(projectId, load);
  return { view, error, reload: load };
}

/** The project's open follow-ups; null while loading. */
export function useFollowUps(projectId: string) {
  const [followUps, setFollowUps] = useState<FollowUpView[] | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(
      `${base}/projects/${projectId}/followups?state=open`,
    ).catch(() => null);
    if (!response?.ok) return;
    setFollowUps(
      ((await response.json()) as { followUps: FollowUpView[] }).followUps,
    );
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  useOnChange(projectId, load);
  return { followUps, reload: load };
}

export type SyncResult =
  { ok: true } | { ok: false; error: string; command?: string };

/** Sync now: GitHub syncs on the server; a script source answers with the CLI command. */
export async function syncBacklog(projectId: string): Promise<SyncResult> {
  const response = await fetch(`${base}/projects/${projectId}/backlog/sync`, {
    method: "POST",
  }).catch(() => null);
  if (!response) return { ok: false, error: "Couldn't reach the server" };
  if (response.ok) {
    backlogChanged(projectId);
    return { ok: true };
  }
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    command?: string;
  };
  return {
    ok: false,
    error: body.error ?? `Sync failed (HTTP ${response.status})`,
    ...(body.command ? { command: body.command } : {}),
  };
}

export type FollowUpAction = "accept" | "dismiss" | "start";

/** Triage one follow-up; "start" answers with a command to copy. */
export async function followUpAction(
  id: string,
  action: FollowUpAction,
): Promise<{ followUp: FollowUpView; command?: string }> {
  const response = await fetch(`${base}/followups/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    followUp?: FollowUpView;
    command?: string;
    error?: string;
  };
  if (!response.ok || !body.followUp)
    throw new Error(body.error ?? `HTTP ${response.status}`);
  return {
    followUp: body.followUp,
    ...(body.command ? { command: body.command } : {}),
  };
}

/** "3m ago", compact for a section header. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** "2026-10-24" → "24 Oct". */
export function shortDate(date: string): string {
  return new Date(`${date.slice(0, 10)}T00:00:00Z`).toLocaleDateString(
    "en-AU",
    { day: "numeric", month: "short", timeZone: "UTC" },
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
