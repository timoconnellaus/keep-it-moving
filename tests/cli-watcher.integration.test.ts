import { execFile } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { InterviewStore } from "../src/server/store.js";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function listeningHarness() {
  const store = new InterviewStore(":memory:");
  const app = await createApp({
    store,
    port: 47831,
    webRoot: "/missing",
    geminiKeyFile: "/missing/gemini-api-key",
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    await app.close();
    store.close();
  });
  return { app, address };
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
      { env: { ...process.env, INTERVIEWER_URL: address } },
    );
    const session = JSON.parse(created.stdout);
    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(session.title).toBe("Todo list product interview");
    const listed = await exec(process.execPath, [tsx, cli, "session", "list"], {
      env: { ...process.env, INTERVIEWER_URL: address },
    });
    expect(
      JSON.parse(listed.stdout).map((item: { id: string }) => item.id),
    ).toContain(session.id);
  });
});

describe("stored Gemini key", () => {
  it("stores a piped key privately and never prints it", async () => {
    const home = mkdtempSync(join(tmpdir(), "interviewer-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
      .pathname;
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [tsx, cli, "config", "gemini-key"],
        { env: { ...process.env, HOME: home } },
        (error, out) => (error ? reject(error) : resolve(out)),
      );
      child.stdin!.end("secret-key-123\n");
    });
    const { file } = JSON.parse(stdout) as { file: string };
    expect(stdout).not.toContain("secret-key-123");
    expect(file.startsWith(home)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe("secret-key-123");
    expect(statSync(file).mode & 0o777).toBe(0o600);
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
          INTERVIEWER_URL: address,
          INTERVIEWER_ARCHIFY: archify,
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
  it("rejects a second watcher and releases the lease on disconnect", async () => {
    const { address } = await listeningHarness();
    const created = (await fetch(`${address}/api/sessions`, {
      method: "POST",
    }).then((response) => response.json())) as { id: string };
    const controller = new AbortController();
    const first = await fetch(`${address}/api/sessions/${created.id}/attach`, {
      signal: controller.signal,
    });
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();
    await reader.read();
    const second = await fetch(`${address}/api/sessions/${created.id}/attach`);
    expect(second.status).toBe(409);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const next = await fetch(
      `${address}/api/sessions/${created.id}/events/next?timeout=1`,
    );
    expect(next.status).toBe(200);
  });
});
