import {
  createHub,
  type AgentSocket,
  type AgentWatch,
  type BrowserSockets,
  type PushSender,
} from "../../src/server/hub.js";
import { InterviewStore } from "../../src/server/store.js";
import { nodeSql } from "./nodeSql.js";

export interface Injected {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  json(): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** The hub with a node:sqlite store, in the shape the old Fastify tests used. */
export function hubHarness(
  options: {
    path?: string;
    sockets?: BrowserSockets;
    push?: { publicKey: string; send: PushSender };
  } = {},
) {
  const sql = nodeSql(options.path);
  const store = new InterviewStore(sql);
  const agents = fakeAgentSockets(() => hub);
  const hub = createHub({
    store,
    sql,
    baseUrl: "https://interviewer.test",
    push: options.push,
    agentSockets: agents,
    sockets: options.sockets ?? {
      send: () => undefined,
      sendAll: () => undefined,
    },
  });
  const inject = async (request: {
    method: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }): Promise<Injected> => {
    const response = await hub.app.request(request.url, {
      method: request.method,
      headers: {
        ...(request.payload !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...request.headers,
      },
      ...(request.payload !== undefined
        ? { body: JSON.stringify(request.payload) }
        : {}),
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers),
      body,
      json: () => JSON.parse(body),
    };
  };
  return { app: { inject, fetch: hub.app.fetch }, store, sql, hub, agents };
}

/** An agent socket in memory: what the hub sent it, and whether it closed. */
export interface FakeAgentSocket extends AgentSocket {
  id: number;
  sent: string[];
  closed: { code: number; reason: string } | null;
  /** The messages so far, parsed. */
  messages(): any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The client went away. */
  disconnect(): void;
  /** Hands later sends and the close to a real connection. */
  connect(peer: {
    send(data: string): void;
    close(code: number, reason: string): void;
  }): void;
}

/** Response header naming the socket an upgrade request was accepted as. */
export const ACCEPTED_SOCKET = "x-test-agent-socket";

/**
 * The hub's agent sockets without a network, standing in for hibernating
 * WebSockets; the alarm is a timer, so fake timers drive it.
 */
function fakeAgentSockets(hub: () => ReturnType<typeof createHub>) {
  const all: FakeAgentSocket[] = [];
  let alarm: ReturnType<typeof setTimeout> | null = null;
  const state = { alarmAt: null as number | null };
  return {
    all,
    state,
    accept(watch: AgentWatch) {
      let peer: Parameters<FakeAgentSocket["connect"]>[0] | null = null;
      const socket: FakeAgentSocket = {
        id: all.length + 1,
        watch,
        sent: [],
        closed: null,
        messages: () => socket.sent.map((data) => JSON.parse(data)),
        send(data) {
          if (socket.closed) throw new Error("Socket closed");
          socket.sent.push(data);
          peer?.send(data);
        },
        close(code, reason) {
          if (socket.closed) return;
          socket.closed = { code, reason };
          peer?.close(code, reason);
          // A real close reaches the host a moment later.
          queueMicrotask(() => hub().agentSocketClosed(watch.sessionId));
        },
        disconnect() {
          if (socket.closed) return;
          socket.closed = { code: 1006, reason: "" };
          hub().agentSocketClosed(watch.sessionId);
        },
        connect(next) {
          peer = next;
          for (const data of socket.sent) next.send(data);
          if (socket.closed)
            next.close(socket.closed.code, socket.closed.reason);
        },
      };
      all.push(socket);
      return {
        socket,
        response: new Response(null, {
          headers: { [ACCEPTED_SOCKET]: String(socket.id) },
        }),
      };
    },
    list(sessionId?: string) {
      return all.filter(
        (socket) =>
          !socket.closed &&
          (sessionId === undefined || socket.watch.sessionId === sessionId),
      );
    },
    wakeAt(time: number | null) {
      state.alarmAt = time;
      if (alarm) clearTimeout(alarm);
      alarm =
        time === null
          ? null
          : setTimeout(() => hub().wake(), Math.max(0, time - Date.now()));
    },
  };
}
