import { useEffect, useState } from "react";
import { agentConnected, type SessionView } from "../shared/schema.js";
import { relativeTime } from "./overview.js";

/** The time now, ticking every `ms`, so labels that depend on it update. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Whether the interview's agent is connected: waiting on it, or its hooks asked lately. */
export function useAgentConnected(session: SessionView): boolean {
  return agentConnected(session, useNow());
}

/** "Read by the agent · 2 min ago", for an answer or message that reached it. */
export const readLabel = (deliveredAt: string, now = Date.now()) => {
  const when = relativeTime(deliveredAt, now);
  return `Read by agent · ${when === "now" ? "just now" : when}`;
};
