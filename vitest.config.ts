import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The Worker's tests run in Node, where Cloudflare's runtime module is a stub.
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./tests/helpers/cloudflareWorkers.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    // Node 25's own localStorage would shadow jsdom's in the UI tests.
    execArgv: ["--no-experimental-webstorage"],
    coverage: { reporter: ["text", "json-summary"] },
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
