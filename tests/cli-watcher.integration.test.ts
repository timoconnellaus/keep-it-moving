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

describe("designs checked by the CLI", () => {
  async function cli() {
    const { address } = await listeningHarness();
    const dir = mkdtempSync(join(tmpdir(), "interviewer-design-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
      .pathname;
    const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
    const run = (...args: string[]) =>
      exec(process.execPath, [tsx, cliPath, ...args], {
        env: { ...process.env, KEEP_IT_MOVING_URL: address },
      });
    /** The CLI's JSON error, when it fails. */
    const failure = (...args: string[]) =>
      run(...args).then(
        () => null,
        (error: { stderr?: string }) =>
          JSON.parse(error.stderr!.trim().split("\n").pop()!) as Record<
            string,
            unknown
          >,
      );
    const session = JSON.parse((await run("session", "create")).stdout) as {
      id: string;
    };
    const file = (name: string, text: string) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    };
    return { run, failure, session, file };
  }

  it("refuses a design that won't draw, naming the line", async () => {
    const { run, failure, session, file } = await cli();
    const bad = file("orders.d2", "web -> api\napi ->\n");
    const refused = await failure("artifact", "add", session.id, "--file", bad);
    expect(refused?.error).toContain("wasn't saved (line 2");
    expect(refused?.design).toMatchObject({
      type: "architecture",
      line: 2,
      text: "api ->",
    });
    const shown = JSON.parse((await run("session", "show", session.id)).stdout);
    expect(shown.artifacts).toEqual([]);
  }, 60_000);

  it("saves a design that draws, and checks its updates", async () => {
    const { run, failure, session, file } = await cli();
    const good = file(
      "flow.mmd",
      "sequenceDiagram\n  Web->>API: order\n  API-->>Web: ok\n",
    );
    const added = JSON.parse(
      (await run("artifact", "add", session.id, "--file", good)).stdout,
    ) as { id: string; designType: string };
    expect(added.designType).toBe("sequence");
    const bad = file("flow-2.mmd", "sequenceDiagram\n  Web->>: order\n");
    const refused = await failure(
      "artifact",
      "update",
      session.id,
      added.id,
      "--file",
      bad,
    );
    expect(refused?.design).toMatchObject({ type: "sequence", line: 2 });
  }, 60_000);
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
