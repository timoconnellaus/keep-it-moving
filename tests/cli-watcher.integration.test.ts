import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { hubHarness } from "./helpers/harness.js";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** The hub served over real HTTP, without auth, as the CLI sees a local Worker. */
async function listeningHarness() {
  const { app, sql } = hubHarness();
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      () => resolve(started),
    );
  });
  const { port } = server.address() as AddressInfo;
  cleanups.push(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    sql.close();
  });
  return { address: `http://127.0.0.1:${port}` };
}

describe("spawned CLI seam", () => {
  it("returns JSON from a real CLI process", async () => {
    const { address } = await listeningHarness();
    const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
      .pathname;
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const created = await exec(
      process.execPath,
      [tsx, cli, "session", "create", "--title", "Todo list product interview"],
      {
        env: {
          ...process.env,
          KEEP_IT_MOVING_URL: address,
        },
      },
    );
    const session = JSON.parse(created.stdout);
    expect(session.url).toMatch(/^https:\/\/interviewer\.test\/s\//);
    expect(session.stageVisible).toBe(false);
    expect(session.title).toBe("Todo list product interview");
    const listed = await exec(process.execPath, [tsx, cli, "session", "list"], {
      env: {
        ...process.env,
        KEEP_IT_MOVING_URL: address,
      },
    });
    expect(
      JSON.parse(listed.stdout).map((item: { id: string }) => item.id),
    ).toContain(session.id);
  });
});

describe("workspace through the CLI", () => {
  it("opens and closes the workspace column", async () => {
    const { address } = await listeningHarness();
    const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
      .pathname;
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const run = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(process.execPath, [tsx, cli, ...args], {
            env: {
              ...process.env,
              KEEP_IT_MOVING_URL: address,
            },
          })
        ).stdout,
      );
    const session = await run("session", "create", "--open-stage");
    expect(session.stageVisible).toBe(true);
    await run("stage", "close", session.id);
    expect((await run("session", "show", session.id)).stageVisible).toBe(false);
  });
});

describe("archify diagrams through the CLI", () => {
  // Stands in for the archify skill: validation fails on a component named
  // "broken"; rendering writes HTML naming the diagram type and title.
  const FAKE_ARCHIFY = `
import { readFileSync, writeFileSync } from "node:fs";
const [command, type, input, output] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(input, "utf8"));
if (command === "validate") {
  const broken = spec.components?.some((c) => c.id === "broken");
  console.log(JSON.stringify(broken
    ? { ok: false, error: "layout failed", diagnostics: [{ code: "layout/constraint", supportedFixes: ["move it"] }] }
    : { ok: true, checks: [] }));
} else if (command === "render") {
  writeFileSync(output, "<!doctype html><html><body>" + type + ": " + spec.meta.title + "</body></html>");
}
`;

  async function cliWithFakeArchify() {
    const { address } = await listeningHarness();
    const dir = mkdtempSync(join(tmpdir(), "interviewer-archify-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const archify = join(dir, "archify.mjs");
    writeFileSync(archify, FAKE_ARCHIFY);
    const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
      .pathname;
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const run = (...args: string[]) =>
      exec(process.execPath, [tsx, cli, ...args], {
        env: {
          ...process.env,
          KEEP_IT_MOVING_URL: address,
          KEEP_IT_MOVING_ARCHIFY: archify,
        },
      });
    const session = JSON.parse((await run("session", "create")).stdout);
    return { address, dir, run, session };
  }

  it("validates and renders a spec, storing the HTML and the spec", async () => {
    const { address, dir, run, session } = await cliWithFakeArchify();
    const spec = join(dir, "sync.architecture.json");
    const text = JSON.stringify({
      diagram_type: "architecture",
      meta: { title: "Sync" },
      components: [{ id: "api" }],
    });
    writeFileSync(spec, text);
    const added = JSON.parse(
      (await run("artifact", "add", session.id, "--file", spec)).stdout,
    );
    expect(added).toMatchObject({
      kind: "diagram",
      title: "Sync",
      format: "html",
    });
    const browser = await (
      await fetch(`${address}/api/browser/${session.token}/session`)
    ).json();
    expect(browser.artifacts[0].source).toBe(text);
    const view = await fetch(
      `${address}/api/browser/${session.token}/artifacts/${added.id}/view`,
    );
    expect(await view.text()).toContain("architecture: Sync");
  });

  it("reports archify's diagnostics when a spec fails validation", async () => {
    const { dir, run, session } = await cliWithFakeArchify();
    const spec = join(dir, "bad.architecture.json");
    writeFileSync(
      spec,
      JSON.stringify({
        diagram_type: "architecture",
        meta: { title: "Bad" },
        components: [{ id: "broken" }],
      }),
    );
    const failure = await run(
      "artifact",
      "add",
      session.id,
      "--file",
      spec,
    ).then(
      () => null,
      (error: { stdout?: string; stderr?: string }) =>
        `${error.stdout ?? ""}${error.stderr ?? ""}`,
    );
    expect(failure).toContain("archify validation failed");
    expect(failure).toContain("move it");
  });
});

describe("watcher lease seam", () => {
  it("lets a newer watcher take over and ends the old one", async () => {
    const { address } = await listeningHarness();
    const created = (await fetch(`${address}/api/sessions`, {
      method: "POST",
    }).then((response) => response.json())) as { id: string };
    const first = await fetch(`${address}/api/sessions/${created.id}/attach`);
    expect(first.status).toBe(200);
    const firstText = first.text();
    const second = await fetch(`${address}/api/sessions/${created.id}/attach`);
    expect(second.status).toBe(200);
    // The old stream says why it ended, then closes.
    expect(await firstText).toContain('"type":"replaced"');
    await second.body!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const next = await fetch(
      `${address}/api/sessions/${created.id}/events/next?timeout=1`,
    );
    expect(next.status).toBe(200);
  });

  it("hands queued answers to the wait that took over", async () => {
    const { address } = await listeningHarness();
    const session = (await fetch(`${address}/api/sessions`, {
      method: "POST",
    }).then((response) => response.json())) as { id: string };
    const base = `${address}/api/sessions/${session.id}`;
    const { questions } = (await fetch(`${base}/questions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "text", prompt: "Name?" }),
    }).then((response) => response.json())) as {
      questions: Array<{ id: string }>;
    };
    // A stale wait, as left behind by a killed CLI.
    const stale = fetch(`${base}/wait?idle=0&timeout=60000`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fresh = fetch(`${base}/wait?idle=0&timeout=60000`);
    const replaced = await stale;
    expect(replaced.status).toBe(409);
    expect(((await replaced.json()) as { error: string }).error).toMatch(
      /replaced by a newer watcher/i,
    );
    await fetch(`${base}/questions/${questions[0]!.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "Keep it moving" }),
    });
    const batch = (await (await fresh).json()) as {
      answers: Array<{ answer: string }>;
      events: Array<{ type: string }>;
    };
    expect(batch.answers.map((answer) => answer.answer)).toEqual([
      "Keep it moving",
    ]);
    // Events queued before the takeover reach the new watcher too.
    expect(batch.events.map((event) => event.type)).toContain("question.added");
  });
});
