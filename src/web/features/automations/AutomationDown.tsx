import { useState } from "react";
import {
  formatAge,
  formatInterval,
  type AutomationDownData,
} from "../../../shared/automations.js";
import type { InboxItem } from "../../../shared/inbox.js";
import { removeAutomation, useNow } from "./shared.js";

/**
 * An automation that missed its check-ins: the expected interval, the last
 * heartbeat and the machine, then what to do about it.
 */
export function AutomationDown({
  item,
  done,
}: {
  item: InboxItem;
  done: () => void;
}) {
  const now = useNow();
  const [error, setError] = useState<string | null>(null);
  const data = item.data as unknown as AutomationDownData | undefined;
  if (!data) return null;
  const machine =
    data.machineAlive === null
      ? (data.machine ?? "Unknown")
      : `${data.machine} · ${data.machineAlive ? "alive" : "offline"}`;
  const restart = data.command ?? "the loop";
  const hint =
    data.machineAlive === false
      ? `${data.machine} is offline: it was last seen ${formatAge(Date.parse(data.machineLastSeen!), now)} ago. Wake it, then check the loop is still running.`
      : data.machineAlive
        ? `The loop stopped, but the machine is alive: restart ${restart} on ${data.machine}.`
        : `No machine reported this automation. Restart ${restart} wherever it runs.`;
  const remove = async () => {
    setError(null);
    try {
      await removeAutomation(data.automationId);
      done();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <div className="kim-automations-detail">
      <div className="kim-automations-tiles">
        <div className="kim-automations-tile">
          <div className="kim-automations-label">Expected</div>
          <div className="kim-automations-value">
            every {formatInterval(data.every)}
          </div>
        </div>
        <div className="kim-automations-tile">
          <div className="kim-automations-label">Last heartbeat</div>
          <div className="kim-automations-value kim-automations-down-text">
            {formatAge(Date.parse(data.lastBeat), now)} ago
          </div>
        </div>
        <div className="kim-automations-tile">
          <div className="kim-automations-label">Machine</div>
          <div
            className={`kim-automations-value${data.machineAlive === false ? " kim-automations-down-text" : ""}`}
          >
            {machine}
          </div>
        </div>
      </div>
      {data.lastStatus && (
        <p className="kim-automations-said">
          Last status: <span>{data.lastStatus}</span>
        </p>
      )}
      {data.command && (
        <p className="kim-automations-said">
          Command: <code>{data.command}</code>
        </p>
      )}
      <p className="kim-automations-hint">{hint}</p>
      <button
        type="button"
        className="kim-automations-button"
        onClick={() => void remove()}
      >
        Remove this automation
      </button>
      {error && <p className="kim-automations-error">{error}</p>}
    </div>
  );
}
