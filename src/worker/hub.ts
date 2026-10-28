import { DurableObject } from "cloudflare:workers";
import {
  createHub,
  RESPONDENT_HEADER,
  sameSite,
  type AgentSocket,
  type AgentWatch,
} from "../server/hub.js";
import { durableObjectSql } from "../server/sql.js";
import { InterviewStore } from "../server/store.js";
import type { Env } from "./env.js";
import { webPush } from "./push.js";

/**
 * One user's workspace, in one SQLite-backed Durable Object: their
 * interviews, agent keys and devices. Browser sockets hibernate, tagged with
 * their session id, or `respondent:<id>` for an assignee's page. Agents'
 * sockets, tagged `agent:<id>`, hibernate too, carrying what they wait for;
 * the object's one alarm wakes it when a wait's batch or timeout is due.
 */
export class InterviewHub extends DurableObject<Env> {
  private readonly hub: ReturnType<typeof createHub>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = durableObjectSql(ctx.storage);
    // The CLI's keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    this.hub = createHub({
      store: new InterviewStore(sql),
      sql,
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
              !ctx
                .getTags(socket)
                .some(
                  (tag) =>
                    tag.startsWith("respondent:") || tag.startsWith(AGENT),
                )
            )
              try {
                socket.send(data);
              } catch {
                /* closing */
              }
        },
        closeSession: (sessionId) => {
          for (const tag of [sessionId, respondentTag(sessionId)])
            for (const socket of ctx.getWebSockets(tag))
              try {
                socket.close(4404, "Interview deleted");
              } catch {
                /* closing */
              }
        },
      },
      agentSockets: {
        accept: (watch) => {
          const [client, server] = Object.values(new WebSocketPair()) as [
            WebSocket,
            WebSocket,
          ];
          ctx.acceptWebSocket(server, [agentTag(watch.sessionId)]);
          server.serializeAttachment(watch);
          return {
            socket: agentSocket(server),
            response: new Response(null, { status: 101, webSocket: client }),
          };
        },
        list: (sessionId) =>
          ctx
            .getWebSockets(
              sessionId === undefined ? undefined : agentTag(sessionId),
            )
            .filter(
              (socket) =>
                socket.readyState === WebSocket.OPEN &&
                ctx.getTags(socket).some((tag) => tag.startsWith(AGENT)),
            )
            .map(agentSocket),
        wakeAt: (time) =>
          void (time === null
            ? ctx.storage.deleteAlarm()
            : ctx.storage.setAlarm(time)),
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

  /** A waiting agent's batch or timeout is due. */
  override async alarm(): Promise<void> {
    this.hub.wake();
  }

  override webSocketMessage(): void {
    // Pages and agents only listen; they write through the HTTP API.
  }

  override webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket, 1011);
  }

  override webSocketClose(socket: WebSocket, code: number): void {
    try {
      socket.close(code === 1005 ? 1000 : code);
    } catch {
      /* already closed */
    }
    const agent = this.ctx.getTags(socket).find((tag) => tag.startsWith(AGENT));
    if (agent) this.hub.agentSocketClosed(agent.slice(AGENT.length));
  }
}

const respondentTag = (sessionId: string) => `respondent:${sessionId}`;
const AGENT = "agent:";
const agentTag = (sessionId: string) => `${AGENT}${sessionId}`;

const agentSocket = (socket: WebSocket): AgentSocket => ({
  watch: socket.deserializeAttachment() as AgentWatch,
  send: (data) => socket.send(data),
  close: (code, reason) => socket.close(code, reason),
});
