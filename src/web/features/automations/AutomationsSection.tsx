import { useCallback, useEffect, useState } from "react";
import {
  formatAge,
  formatInterval,
  type MachineView,
  type ProjectAutomation,
} from "../../../shared/automations.js";
import {
  HeartbeatIcon,
  MachineIcon,
  removeAutomation,
  useNow,
  type Liveness,
} from "./shared.js";

interface Data {
  automations: ProjectAutomation[];
  machines: MachineView[];
}

/**
 * Automations & machines on the project page: each loop with its heartbeat,
 * then the machines they run on. It refetches as relative times tick over.
 */
export function AutomationsSection({ projectId }: { projectId: string }) {
  const now = useNow();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(
      `/api/browser/kim/projects/${encodeURIComponent(projectId)}/automations`,
    ).catch(() => null);
    if (!response?.ok) return;
    setData((await response.json()) as Data);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load, now]);

  const remove = async (id: string) => {
    setError(null);
    try {
      await removeAutomation(id);
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  if (!data) return <p className="kim-automations-empty">Loading…</p>;
  if (!data.automations.length)
    return (
      <p className="kim-automations-empty">
        No automations yet. A loop registers itself with{" "}
        <code>interviewer heartbeat &lt;name&gt; --every 5m</code>.
      </p>
    );
  return (
    <div className="kim-automations">
      <ul className="kim-automations-list">
        {data.automations.map((one) => {
          const state: Liveness = one.downSince ? "down" : "alive";
          return (
            <li key={one.id} className="kim-automations-row">
              <HeartbeatIcon
                state={state}
                label={state === "down" ? "Down" : "Alive"}
              />
              <div className="kim-automations-main">
                <div>
                  <span className="kim-automations-name">{one.name}</span>{" "}
                  <span className="kim-automations-meta">
                    {one.command ? `· ${one.command} ` : ""}· every{" "}
                    {formatInterval(one.every)}
                  </span>
                </div>
                {one.lastStatus && (
                  <div className="kim-automations-status">{one.lastStatus}</div>
                )}
              </div>
              <span className={`kim-automations-age kim-automations-${state}`}>
                {one.downSince
                  ? `down ${formatAge(Date.parse(one.downSince), now)}`
                  : ago(one.lastBeat, now)}
              </span>
              {one.downSince && (
                <button
                  type="button"
                  className="kim-automations-remove"
                  aria-label={`Remove ${one.name}`}
                  title="Remove this automation"
                  onClick={() => void remove(one.id)}
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
        {data.machines.map((machine) => {
          const state: Liveness = machine.alive ? "alive" : "unknown";
          return (
            <li key={machine.name} className="kim-automations-row">
              <MachineIcon
                state={state}
                label={machine.alive ? "Machine alive" : "Machine not seen"}
              />
              <div className="kim-automations-main">
                <span className="kim-automations-name">{machine.name}</span>
                {machine.platform && (
                  <span className="kim-automations-meta">
                    {" "}
                    · {machine.platform}
                  </span>
                )}
              </div>
              <span className={`kim-automations-age kim-automations-${state}`}>
                {ago(machine.lastSeen, now)}
              </span>
            </li>
          );
        })}
      </ul>
      {error && <p className="kim-automations-error">{error}</p>}
    </div>
  );
}

function ago(iso: string, now: number): string {
  const age = formatAge(Date.parse(iso), now);
  return age === "just now" ? age : `${age} ago`;
}
