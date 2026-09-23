#!/usr/bin/env node
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import envPaths from "env-paths";
import { createApp } from "./app.js";
import { InterviewStore, defaultDatabasePath } from "./store.js";

const host = "127.0.0.1";
const port = Number(process.env.INTERVIEWER_PORT ?? 47831);
const paths = envPaths("interviewer");
const runtimeFile = `${paths.temp}/daemon.json`;
mkdirSync(dirname(runtimeFile), { recursive: true });
const store = new InterviewStore(
  process.env.INTERVIEWER_DATABASE ?? defaultDatabasePath(),
);
const webRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../web-dist",
);
const app = await createApp({ store, host, port, webRoot });

try {
  await app.listen({ host, port });
  writeFileSync(
    runtimeFile,
    JSON.stringify({
      pid: process.pid,
      host,
      port,
      startedAt: new Date().toISOString(),
    }),
  );
} catch (error) {
  store.close();
  throw error;
}

const shutdown = async () => {
  rmSync(runtimeFile, { force: true });
  await app.close();
  store.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
