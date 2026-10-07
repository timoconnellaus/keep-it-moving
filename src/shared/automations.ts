/** A long-running loop that checks in, such as a project's /loop /babysitter. */
export interface AutomationView {
  id: string;
  projectId: string;
  name: string;
  /** The expected check-in interval, in seconds. */
  every: number;
  command: string | null;
  machine: string | null;
  /** When it last checked in (ISO). */
  lastBeat: string;
  /** What the loop said it did last, e.g. "merged #15; 2 queued". */
  lastStatus: string | null;
  registeredAt: string;
  /** When it went down (ISO): 2 missed check-ins. Null while alive. */
  downSince: string | null;
}

/** A computer that runs the CLI; each heartbeat from it counts. */
export interface MachineView {
  name: string;
  platform: string | null;
  lastSeen: string;
  alive: boolean;
}

/** An automation with its machine's liveness, as the project page shows it. */
export interface ProjectAutomation extends AutomationView {
  machineLastSeen: string | null;
  machineAlive: boolean | null;
}

/** The automation_down inbox item's data. */
export interface AutomationDownData {
  automationId: string;
  every: number;
  lastBeat: string;
  machine: string | null;
  machineLastSeen: string | null;
  machineAlive: boolean | null;
  command: string | null;
  lastStatus: string | null;
}

/** Missing this many check-ins in a row marks an automation down. */
export const MISSED_BEATS = 2;

/** A machine counts as alive if it has been seen this recently. */
export const MACHINE_ALIVE_MS = 10 * 60_000;

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * A duration in seconds from "30s", "5m", "1h", "1d", "1h30m" or a bare
 * number of seconds. Throws on anything else, or on zero.
 */
export function parseDuration(text: string): number {
  const value = text.toLowerCase().replace(/\s+/g, "");
  if (/^\d+$/.test(value) && Number(value) > 0) return Number(value);
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)];
  const consumed = parts.map((part) => part[0]).join("");
  if (!parts.length || consumed !== value)
    throw new Error(
      `Can't read "${text}" as a duration; use e.g. 30s, 5m, 1h or 1d`,
    );
  const seconds = Math.round(
    parts.reduce((sum, [, n, unit]) => sum + Number(n) * UNITS[unit!]!, 0),
  );
  if (seconds <= 0) throw new Error("A duration must be at least 1s");
  return seconds;
}

/** 300 → "5m", 5400 → "1h 30m", 86400 → "1d". */
export function formatInterval(seconds: number): string {
  const parts: string[] = [];
  let rest = Math.max(0, Math.round(seconds));
  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    const count = Math.floor(rest / size);
    if (count) parts.push(`${count}${unit}`);
    rest -= count * size;
  }
  return parts.slice(0, 2).join(" ") || "0s";
}

/** A short age for a past moment: "just now", "40s", "22m", "3h", "2d". */
export function formatAge(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
