import { DurableObject } from "cloudflare:workers";
import { createHub, sameSite } from "../server/hub.js";
import { durableObjectSql } from "../server/sql.js";
import { InterviewStore } from "../server/store.js";
import type { Env } from "./env.js";
import { webPush } from "./push.js";

/**
 * Every interview, in one SQLite-backed Durable Object: the deployment has a
 * single user. Browser sockets hibernate, tagged with their session id.
 */
export class InterviewHub extends DurableObject<Env> {
  private readonly hub: ReturnType<typeof createHub>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.hub = createHub({
      store: new InterviewStore(durableObjectSql(ctx.storage)),
      baseUrl: env.PUBLIC_URL,
      push: webPush(env),
      sockets: {
        send: (sessionId, data) => {
          for (const socket of ctx.getWebSockets(sessionId))
            try {
              socket.send(data);
            } catch {
              /* closing */
            }
        },
        sendAll: (data) => {
          for (const socket of ctx.getWebSockets())
            try {
              socket.send(data);
            } catch {
              /* closing */
            }
        },
      },
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const socket = new URL(request.url).pathname.match(/^\/ws\/([^/]+)$/);
    if (!socket) return this.hub.app.fetch(request);
    // WebSockets skip CORS, so check the page opening one is our own.
    if (!sameSite(request))
      return new Response("Cross-site socket refused", { status: 403 });
    if (request.headers.get("upgrade") !== "websocket")
      return new Response("Expected a WebSocket", { status: 426 });
    // The home page listens for list changes only; tokens are never this short.
    let sessionId = "overview";
    if (socket[1] !== "overview")
      try {
        sessionId = this.hub.tokenSession(socket[1]!);
      } catch {
        return new Response("Session not found", { status: 404 });
      }
    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];
    this.ctx.acceptWebSocket(server, [sessionId]);
    if (sessionId !== "overview") server.send(this.hub.stateMessage(sessionId));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(): void {
    // The page only listens; it writes through the HTTP API.
  }

  override webSocketClose(socket: WebSocket, code: number): void {
    socket.close(code === 1005 ? 1000 : code);
  }
}
