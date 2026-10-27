import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { ACCEPTED_SOCKET, type hubHarness } from "./harness.js";

/**
 * The hub over real HTTP and WebSockets, without auth, as the CLI sees a
 * local Worker. `fetch` may wrap the hub's, to record or refuse requests.
 */
export async function serveHarness(
  harness: ReturnType<typeof hubHarness>,
  fetch: (request: Request) => Response | Promise<Response> = (request) =>
    harness.app.fetch(request),
) {
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch, hostname: "127.0.0.1", port: 0 }, () =>
      resolve(started),
    );
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on(
    "upgrade",
    (request: IncomingMessage, raw: Duplex, head: Buffer) => {
      void (async () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers))
          if (typeof value === "string") headers.set(name, value);
        const response = await fetch(
          new Request(`http://${request.headers.host}${request.url}`, {
            headers,
          }),
        );
        const id = Number(response.headers.get(ACCEPTED_SOCKET));
        const fake = harness.agents.all.find((socket) => socket.id === id);
        if (!fake) {
          raw.end(
            `HTTP/1.1 ${response.status} ${response.statusText || "Refused"}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
          );
          return;
        }
        sockets.handleUpgrade(request, raw, head, (ws) => {
          ws.on("message", (data) => {
            if (String(data) === "ping") ws.send("pong");
          });
          ws.on("close", () => fake.disconnect());
          fake.connect({
            send: (data) => ws.send(data),
            close: (code, reason) => ws.close(code, reason),
          });
        });
      })();
    },
  );
  const { port } = server.address() as AddressInfo;
  return {
    address: `http://127.0.0.1:${port}`,
    async close() {
      for (const client of sockets.clients) client.terminate();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
