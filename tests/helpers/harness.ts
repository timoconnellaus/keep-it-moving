import {
  createHub,
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
  const hub = createHub({
    store,
    baseUrl: "https://interviewer.test",
    push: options.push,
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
  return { app: { inject, fetch: hub.app.fetch }, store, sql, hub };
}
