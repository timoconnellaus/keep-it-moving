import { DurableObject } from "cloudflare:workers";
import { createHub, RESPONDENT_HEADER, sameSite } from "../server/hub.js";
import { durableObjectSql } from "../server/sql.js";
import { InterviewStore } from "../server/store.js";
import type { Env } from "./env.js";
import { isOwnerHub } from "./hubs.js";
import { webPush } from "./push.js";

/**
 * One user's workspace, in one SQLite-backed Durable Object: their
 * interviews and everything else. Browser sockets hibernate, tagged with
 * their session id, or `respondent:<id>` for an assignee's page.
 */
export class InterviewHub extends DurableObject<Env> {
  private readonly hub: ReturnType<typeof createHub>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = durableObjectSql(ctx.storage);
    this.hub = createHub({
      store: new InterviewStore(sql),
      sql,
      // The server's GitHub token is the owner's; other users go without.
      env: {
        githubToken: isOwnerHub(env, ctx.id) ? env.GITHUB_TOKEN : undefined,
      },
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
        sendRespondent: (sessionId, data) => {
          for (const socket of ctx.getWebSockets(respondentTag(sessionId)))
            try {
              socket.send(data);
            } catch {
              /* closing */
            }
        },
        closeRespondents: (sessionId) => {
          for (const socket of ctx.getWebSockets(respondentTag(sessionId)))
            try {
              socket.close(1008, "No longer shared with you");
            } catch {
              /* closing */
            }
        },
        // List changes are the owner's business only.
        sendAll: (data) => {
          for (const socket of ctx.getWebSockets())
            if (
              !ctx.getTags(socket).some((tag) => tag.startsWith("respondent:"))
            )
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
    await this.scheduleTick();
    const socket = new URL(request.url).pathname.match(/^\/ws\/([^/]+)$/);
    if (!socket) return this.hub.app.fetch(request);
    // WebSockets skip CORS, so check the page opening one is our own.
    if (!sameSite(request))
      return new Response("Cross-site socket refused", { status: 403 });
    if (request.headers.get("upgrade") !== "websocket")
      return new Response("Expected a WebSocket", { status: 426 });
    // An assignee listens to their one interview, never the list.
    const respondent = request.headers.get(RESPONDENT_HEADER);
    if (
      respondent !== null &&
      !this.hub.respondentMayUse(socket[1]!, respondent)
    )
      return new Response("Not shared with you", { status: 403 });
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
    this.ctx.acceptWebSocket(server, [
      respondent === null ? sessionId : respondentTag(sessionId),
    ]);
    if (sessionId !== "overview")
      server.send(this.hub.stateMessage(sessionId, respondent !== null));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Feature timer work (missed heartbeats, CI polling) runs once a minute. */
  override async alarm(): Promise<void> {
    await this.hub.tick();
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  private async scheduleTick(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  override webSocketMessage(): void {
    // The page only listens; it writes through the HTTP API.
  }

  override webSocketClose(socket: WebSocket, code: number): void {
    socket.close(code === 1005 ? 1000 : code);
  }
}

const TICK_MS = 60_000;

const respondentTag = (sessionId: string) => `respondent:${sessionId}`;
