import { afterEach, describe, expect, it } from "vitest";
import { formatInterval, parseDuration } from "../src/shared/automations.js";
import { hubHarness } from "./helpers/harness.js";

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((close) => close()));
function harness() {
  const result = hubHarness();
  closers.push(() => result.sql.close());
  return result;
}

const KEY = "github.com/timoconnellaus/frockbot";
const MINUTE = 60_000;

async function beat(
  app: ReturnType<typeof harness>["app"],
  extra: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions/kim/heartbeat",
    payload: {
      project: KEY,
      name: "babysitter",
      every: 300,
      command: "/loop /babysitter",
      machine: "tim-mbp",
      platform: "darwin",
      ...extra,
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

/** Moves the last beat (and the machine's last sighting) back in time. */
function age(
  sql: ReturnType<typeof harness>["sql"],
  beatMsAgo: number,
  machineMsAgo = beatMsAgo,
) {
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();
  sql.all("UPDATE automations SET last_beat = ?", at(beatMsAgo));
  sql.all("UPDATE machines SET last_seen = ?", at(machineMsAgo));
}

describe("durations", () => {
  it("reads the CLI's --every values as seconds", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("1h")).toBe(3600);
    expect(parseDuration("1d")).toBe(86_400);
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration(" 2M ")).toBe(120);
    expect(parseDuration("90")).toBe(90);
    for (const bad of ["", "5x", "m5", "0", "0s", "5 minutes", "-5m"])
      expect(() => parseDuration(bad)).toThrow();
  });

  it("formats intervals the way the screens show them", () => {
    expect(formatInterval(300)).toBe("5m");
    expect(formatInterval(5400)).toBe("1h 30m");
    expect(formatInterval(86_400)).toBe("1d");
    expect(formatInterval(45)).toBe("45s");
  });
});

describe("heartbeats", () => {
  it("registers an automation once and updates it on every beat", async () => {
    const { app, store } = harness();
    const first = await beat(app, { status: "2 queued" });
    expect(first).toMatchObject({
      name: "babysitter",
      every: 300,
      command: "/loop /babysitter",
      machine: "tim-mbp",
      lastStatus: "2 queued",
      downSince: null,
    });
    // A later beat keeps the command and status it doesn't repeat.
    const second = await beat(app, { every: 600, command: undefined });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      every: 600,
      command: "/loop /babysitter",
      lastStatus: "2 queued",
    });
    expect(store.listProjects()).toEqual([
      expect.objectContaining({ key: KEY, name: "Frockbot" }),
    ]);

    const listed = await app.inject({
      method: "GET",
      url: `/api/sessions/kim/automations?project=${encodeURIComponent(KEY)}`,
    });
    expect(listed.json().automations).toEqual([
      expect.objectContaining({
        id: first.id,
        machineAlive: true,
        machineLastSeen: expect.any(String),
      }),
    ]);
  });

  it("refuses a beat without a project, name or interval", async () => {
    const { app } = harness();
    for (const payload of [
      { name: "b", every: 60 },
      { project: KEY, every: 60 },
      { project: KEY, name: "b", every: "soon" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/kim/heartbeat",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("goes down after two missed check-ins and recovers on the next beat", async () => {
    const pings: string[] = [];
    const result = hubHarness({
      sockets: { send: () => undefined, sendAll: (data) => pings.push(data) },
    });
    closers.push(() => result.sql.close());
    const { app, hub, sql } = result;
    const automation = await beat(app);
    const lastBeat = Date.parse(automation.lastBeat);

    // Exactly two intervals is still alive; one moment later it is down.
    await hub.tick(lastBeat + 10 * MINUTE);
    expect(hub.inbox()).toEqual([]);
    await hub.tick(lastBeat + 10 * MINUTE + 1);
    const [item] = hub.inbox();
    expect(item).toMatchObject({
      id: `automation_down:${automation.id}`,
      kind: "automation_down",
      since: new Date(lastBeat + 10 * MINUTE).toISOString(),
    });
    // A later tick doesn't move when it went down.
    await hub.tick(lastBeat + 60 * MINUTE);
    expect(hub.inbox()[0]!.since).toBe(item!.since);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const before = pings.length;
    expect(before).toBeGreaterThan(0);
    await beat(app);
    expect(hub.inbox()).toEqual([]);
    const row = sql.all("SELECT down_since FROM automations")[0]!;
    expect(row.down_since).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pings.length).toBeGreaterThan(before);
  });

  it("explains a down automation in the inbox", async () => {
    const { app, hub, sql, store } = harness();
    const automation = await beat(app, { status: "merged #15; 2 queued" });
    const project = store.projectForKey(KEY);

    // The loop stopped 22 minutes ago, but the machine is still about.
    age(sql, 22 * MINUTE, MINUTE);
    await hub.tick(Date.now());
    const [alive] = hub.inbox();
    expect(alive).toMatchObject({
      kind: "automation_down",
      projectId: project.id,
      title: "babysitter missed 4 check-ins",
      source: 'automation "babysitter" · /loop /babysitter · tim-mbp',
      data: {
        automationId: automation.id,
        every: 300,
        machine: "tim-mbp",
        machineAlive: true,
        command: "/loop /babysitter",
        lastStatus: "merged #15; 2 queued",
      },
    });
    expect(alive!.brief).toContain("Expected every 5m");
    expect(alive!.brief).toContain("last heartbeat 22m ago");
    expect(alive!.brief).toContain("tim-mbp is still checking in");

    // Now the machine has gone quiet too.
    age(sql, 22 * MINUTE, 20 * MINUTE);
    const [offline] = hub.inbox();
    expect(offline!.data).toMatchObject({ machineAlive: false });
    expect(offline!.brief).toContain("tim-mbp hasn't been seen for 20m");
  });

  it("gives the project rail a heartbeat state", async () => {
    const { app, hub, sql, store } = harness();
    const projects = async () =>
      (
        await app.inject({ method: "GET", url: "/api/browser/kim/projects" })
      ).json().projects as Array<{
        key: string;
        stats: { heartbeat?: string };
      }>;

    store.projectForKey("github.com/o/quiet");
    await beat(app);
    let listed = await projects();
    expect(listed.find((p) => p.key === KEY)!.stats.heartbeat).toBe("alive");
    // No automations, no heartbeat state (other features add their own stats).
    expect(
      listed.find((p) => p.key === "github.com/o/quiet")!.stats.heartbeat,
    ).toBeUndefined();

    age(sql, 30 * MINUTE);
    await hub.tick(Date.now());
    listed = await projects();
    expect(listed.find((p) => p.key === KEY)!.stats).toMatchObject({
      heartbeat: "down",
      needsYou: 1,
    });
  });

  it("lists a project's automations and machines for the browser, and removes one", async () => {
    const { app, store } = harness();
    const automation = await beat(app);
    await app.inject({
      method: "POST",
      url: "/api/sessions/kim/machines/beat",
      payload: { machine: "studio", platform: "linux" },
    });
    const project = store.projectForKey(KEY);
    const page = await app.inject({
      method: "GET",
      url: `/api/browser/kim/projects/${project.id}/automations`,
    });
    expect(page.json()).toMatchObject({
      automations: [{ id: automation.id, machineAlive: true }],
      // Only the machines this project's automations run on.
      machines: [{ name: "tim-mbp", platform: "darwin", alive: true }],
    });
    const all = await app.inject({
      method: "GET",
      url: "/api/browser/kim/machines",
    });
    expect(all.json().machines).toHaveLength(2);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/browser/kim/automations/${automation.id}`,
    });
    expect(removed.statusCode).toBe(200);
    const again = await app.inject({
      method: "DELETE",
      url: `/api/sessions/kim/automations/${automation.id}`,
    });
    expect(again.statusCode).toBe(404);
  });
});
