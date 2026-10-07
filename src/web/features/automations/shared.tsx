import { useEffect, useState } from "react";

/** The current time, updated every 30 s so relative times stay current. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export type Liveness = "alive" | "down" | "unknown";

/** The heartbeat trace from the mockups: green alive, red down, grey unknown. */
export function HeartbeatIcon({
  state,
  label,
}: {
  state: Liveness;
  label: string;
}) {
  return (
    <svg
      className={`kim-automations-icon kim-automations-${state}`}
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
    >
      <path d="M3 12h4l3-7 4 14 3-7h4" />
    </svg>
  );
}

export function MachineIcon({
  state,
  label,
}: {
  state: Liveness;
  label: string;
}) {
  return (
    <svg
      className={`kim-automations-icon kim-automations-${state}`}
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
    </svg>
  );
}

/** Deletes an automation; the server refuses cross-site writes. */
export async function removeAutomation(id: string): Promise<void> {
  const response = await fetch(
    `/api/browser/kim/automations/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(`Couldn't remove it (${response.status})`);
}
