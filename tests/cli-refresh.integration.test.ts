import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const tsx = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
  .pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

/**
 * A token endpoint that rotates refresh tokens the way the Worker's OAuth
 * provider does: the current and the one just used stay valid, and a refresh
 * makes the one it was given the previous.
 */
async function rotatingServer() {
  let current = "refresh-0";
  let previous: string | null = null;
  let refreshes = 0;
  const issued = new Set<string>();
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/token") {
            const form = new URLSearchParams(await request.text());
            const given = form.get("refresh_token");
            if (given !== current && given !== previous)
              return Response.json({ error: "invalid_grant" }, { status: 400 });
            // Slow enough that concurrent refreshes overlap.
            await new Promise((resolve) => setTimeout(resolve, 150));
            refreshes += 1;
            previous = given;
            current = `refresh-${refreshes}`;
            const access = `access-${refreshes}`;
            issued.add(access);
            return Response.json({
              access_token: access,
              refresh_token: current,
              expires_in: 3600,
            });
          }
          const bearer = request.headers
            .get("authorization")
            ?.replace(/^Bearer /, "");
          return bearer && issued.has(bearer)
            ? Response.json({ sessions: [] })
            : Response.json({ error: "Unauthorized" }, { status: 401 });
        },
      },
      () => resolve(started),
    );
  });
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return {
    address: `http://127.0.0.1:${port}`,
    refreshes: () => refreshes,
  };
}

function signedInHome(address: string) {
  const home = mkdtempSync(join(tmpdir(), "kim-refresh-test-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  // env-paths' config folder for "keep-it-moving".
  const config =
    process.platform === "darwin"
      ? join(home, "Library", "Preferences", "keep-it-moving-nodejs")
      : join(home, ".config", "keep-it-moving-nodejs");
  mkdirSync(config, { recursive: true });
  const file = join(config, "credentials.json");
  const expire = () => {
    const all = JSON.parse(readFileSync(file, "utf8"));
    all[address].expiresAt = 0;
    writeFileSync(file, JSON.stringify(all));
  };
  writeFileSync(
    file,
    JSON.stringify({
      [address]: {
        clientId: "client",
        accessToken: "access-expired",
        refreshToken: "refresh-0",
        expiresAt: 0,
      },
    }),
  );
  return { home, expire };
}

const whoami = (address: string, home: string) => {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  delete env.KEEP_IT_MOVING_TOKEN;
  delete env.INTERVIEWER_TOKEN;
  return exec(process.execPath, [tsx, cli, "whoami"], {
    env: { ...env, KEEP_IT_MOVING_URL: address },
  }).then(({ stdout }) => JSON.parse(stdout) as { signedIn: boolean });
};

describe("token refresh", () => {
  it("refreshes once when several CLI processes find the token expired together", async () => {
    const server = await rotatingServer();
    const { home, expire } = signedInHome(server.address);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => whoami(server.address, home)),
    );
    expect(results.every((result) => result.signedIn)).toBe(true);
    expect(server.refreshes()).toBe(1);
    // The saved refresh token is the one the server still accepts.
    expire();
    expect((await whoami(server.address, home)).signedIn).toBe(true);
  }, 30_000);
});
