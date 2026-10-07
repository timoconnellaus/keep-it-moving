import type { Context, Hono } from "hono";
import {
  formatAge,
  formatInterval,
  MACHINE_ALIVE_MS,
  MISSED_BEATS,
  type AutomationDownData,
  type AutomationView,
  type MachineView,
  type ProjectAutomation,
} from "../../shared/automations.js";
import type { InboxItem, ProjectStats } from "../../shared/inbox.js";
import { first, type Row } from "../sql.js";
import type { Feature, FeatureContext } from "./types.js";

/**
 * Automations and machines: long-running loops (a project's babysitter,
 * crons) check in with `kim heartbeat`, and one that misses
 * MISSED_BEATS check-ins in a row is down and shows in the inbox.
 */
export function automations(ctx: FeatureContext): Feature {
  const { sql, store } = ctx;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      every_s INTEGER NOT NULL, command TEXT, machine TEXT,
      last_beat TEXT NOT NULL, last_status TEXT, registered_at TEXT NOT NULL,
      down_since TEXT,
      UNIQUE (project_id, name)
    );
    CREATE TABLE IF NOT EXISTS machines (
      name TEXT PRIMARY KEY, platform TEXT, last_seen TEXT NOT NULL
    );
  `);

  const body = async (c: Context): Promise<Record<string, unknown>> =>
    ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  /** Records that a machine ran the CLI; its platform is kept if not given. */
  const beatMachine = (name: string, platform: string | null, at: string) =>
    sql.all(
      `INSERT INTO machines (name, platform, last_seen) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         platform = COALESCE(excluded.platform, platform), last_seen = excluded.last_seen`,
      name,
      platform,
      at,
    );

  const machines = (now = Date.now()): MachineView[] =>
    sql
      .all("SELECT * FROM machines ORDER BY last_seen DESC")
      .map((row) => mapMachine(row, now));
  const machine = (name: string | null, now = Date.now()) => {
    const row = name
      ? first(sql, "SELECT * FROM machines WHERE name = ?", name)
      : undefined;
    return row ? mapMachine(row, now) : null;
  };
  const withMachine = (
    automation: AutomationView,
    now = Date.now(),
  ): ProjectAutomation => {
    const seen = machine(automation.machine, now);
    return {
      ...automation,
      machineLastSeen: seen?.lastSeen ?? null,
      machineAlive: seen?.alive ?? null,
    };
  };

  /**
   * Registers or updates the automation and marks it alive. Coming back
   * from down, or appearing for the first time, changes what pages show.
   */
  const heartbeat = (input: Record<string, unknown>) => {
    const key = text(input.project);
    const name = text(input.name);
    const every = Number(input.every);
    if (!key) throw new Error("project is required");
    if (!name) throw new Error("name is required");
    if (!Number.isFinite(every) || every < 1)
      throw new Error("every must be a number of seconds");
    const project = store.projectForKey(key);
    const at = new Date().toISOString();
    const machineName = text(input.machine);
    if (machineName) beatMachine(machineName, text(input.platform), at);
    const existing = first(
      sql,
      "SELECT id, down_since FROM automations WHERE project_id = ? AND name = ?",
      project.id,
      name,
    );
    const id = existing ? String(existing.id) : crypto.randomUUID();
    sql.all(
      `INSERT INTO automations (id, project_id, name, every_s, command, machine,
         last_beat, last_status, registered_at, down_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (project_id, name) DO UPDATE SET
         every_s = excluded.every_s,
         command = COALESCE(excluded.command, command),
         machine = COALESCE(excluded.machine, machine),
         last_beat = excluded.last_beat,
         last_status = COALESCE(excluded.last_status, last_status),
         down_since = NULL`,
      id,
      project.id,
      name,
      Math.round(every),
      text(input.command),
      machineName,
      at,
      text(input.status),
      at,
    );
    if (!existing || existing.down_since) ctx.changed();
    return automation(id)!;
  };

  const automation = (id: string) => {
    const row = first(sql, "SELECT * FROM automations WHERE id = ?", id);
    return row ? mapAutomation(row) : null;
  };
  const remove = (id: string) => {
    if (!automation(id)) throw new Error("Automation not found");
    sql.all("DELETE FROM automations WHERE id = ?", id);
    ctx.changed();
  };
  const forProject = (projectId: string) =>
    sql
      .all(
        "SELECT * FROM automations WHERE project_id = ? ORDER BY lower(name)",
        projectId,
      )
      .map(mapAutomation);

  return {
    name: "automations",

    /** Each automation's health: alive or down, and its machine. */
    projectContext(project) {
      const now = Date.now();
      return {
        automations: forProject(project.id).map((one) => {
          const full = withMachine(one, now);
          return {
            name: full.name,
            every: formatInterval(full.every),
            down: full.downSince !== null,
            downSince: full.downSince,
            lastBeat: full.lastBeat,
            lastStatus: full.lastStatus,
            machine: full.machine,
            machineAlive: full.machineAlive,
          };
        }),
      };
    },

    agentRoutes(app: Hono) {
      app.post("/heartbeat", async (c) => c.json(heartbeat(await body(c))));
      app.post("/machines/beat", async (c) => {
        const input = await body(c);
        const name = text(input.machine);
        if (!name) throw new Error("machine is required");
        beatMachine(name, text(input.platform), new Date().toISOString());
        return c.json(machine(name));
      });
      app.get("/automations", (c) => {
        const key = c.req.query("project");
        const rows = key
          ? sql.all(
              `SELECT a.* FROM automations a JOIN projects p ON p.id = a.project_id
               WHERE p.key = ? OR lower(p.name) = lower(?) ORDER BY lower(a.name)`,
              key,
              key,
            )
          : sql.all("SELECT * FROM automations ORDER BY lower(name)");
        return c.json({
          automations: rows.map((row) => withMachine(mapAutomation(row))),
        });
      });
      app.delete("/automations/:id", (c) => {
        remove(c.req.param("id"));
        return c.json({ ok: true });
      });
    },

    browserRoutes(app: Hono) {
      app.get("/projects/:id/automations", (c) => {
        const now = Date.now();
        const list = forProject(c.req.param("id")).map((one) =>
          withMachine(one, now),
        );
        // The machines this project's automations run on.
        const names = new Set(list.map((one) => one.machine).filter(Boolean));
        return c.json({
          automations: list,
          machines: machines(now).filter((one) => names.has(one.name)),
        });
      });
      app.get("/machines", (c) => c.json({ machines: machines() }));
      app.delete("/automations/:id", (c) => {
        remove(c.req.param("id"));
        return c.json({ ok: true });
      });
    },

    /** Marks automations down once they have missed MISSED_BEATS check-ins. */
    tick(now: number) {
      let wentDown = false;
      for (const row of sql.all(
        "SELECT id, every_s, last_beat FROM automations WHERE down_since IS NULL",
      )) {
        const downAt =
          Date.parse(String(row.last_beat)) +
          MISSED_BEATS * Number(row.every_s) * 1000;
        if (now <= downAt) continue;
        sql.all(
          "UPDATE automations SET down_since = ? WHERE id = ?",
          new Date(downAt).toISOString(),
          String(row.id),
        );
        wentDown = true;
      }
      if (wentDown) ctx.changed();
    },

    inbox(): InboxItem[] {
      const now = Date.now();
      return sql
        .all(
          "SELECT * FROM automations WHERE down_since IS NOT NULL ORDER BY down_since",
        )
        .map((row) => {
          const one = withMachine(mapAutomation(row), now);
          const lastBeat = Date.parse(one.lastBeat);
          const missed = Math.max(
            MISSED_BEATS,
            Math.floor((now - lastBeat) / (one.every * 1000)),
          );
          const machineNote =
            one.machineAlive === null
              ? "No machine reported it, so it isn't known whether the machine is up."
              : one.machineAlive
                ? `${one.machine} is still checking in, so the loop itself has stopped.`
                : `${one.machine} hasn't been seen for ${formatAge(Date.parse(one.machineLastSeen!), now)}, so the machine may be off or asleep.`;
          const data: AutomationDownData = {
            automationId: one.id,
            every: one.every,
            lastBeat: one.lastBeat,
            machine: one.machine,
            machineLastSeen: one.machineLastSeen,
            machineAlive: one.machineAlive,
            command: one.command,
            lastStatus: one.lastStatus,
          };
          return {
            id: `automation_down:${one.id}`,
            kind: "automation_down" as const,
            projectId: one.projectId,
            title: `${one.name} missed ${missed} check-ins`,
            brief: `Expected every ${formatInterval(one.every)}; last heartbeat ${formatAge(lastBeat, now)} ago. ${machineNote}`,
            source: [`automation "${one.name}"`, one.command, one.machine]
              .filter(Boolean)
              .join(" · "),
            since: one.downSince!,
            data: { ...data },
          };
        });
    },

    projectStats() {
      const stats: Record<string, ProjectStats> = {};
      for (const row of sql.all(
        `SELECT project_id, MAX(down_since IS NOT NULL) down
         FROM automations GROUP BY project_id`,
      ))
        stats[String(row.project_id)] = {
          heartbeat: Number(row.down) ? "down" : "alive",
        };
      return stats;
    },
  };
}

function mapAutomation(row: Row): AutomationView {
  const optional = (value: unknown) =>
    value === null || value === undefined ? null : String(value);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    every: Number(row.every_s),
    command: optional(row.command),
    machine: optional(row.machine),
    lastBeat: String(row.last_beat),
    lastStatus: optional(row.last_status),
    registeredAt: String(row.registered_at),
    downSince: optional(row.down_since),
  };
}

function mapMachine(row: Row, now: number): MachineView {
  const lastSeen = String(row.last_seen);
  return {
    name: String(row.name),
    platform: row.platform === null ? null : String(row.platform),
    lastSeen,
    alive: now - Date.parse(lastSeen) <= MACHINE_ALIVE_MS,
  };
}
