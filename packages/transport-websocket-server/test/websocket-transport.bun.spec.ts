import { describe, expect, it } from "bun:test";
import type { CompiledRoute } from "@scomp/core";
import type { ScompTransportSecurityPolicy } from "@scomp/types";
import {
  createBunWebSocketServerTransport,
  type BunWebSocketServerTransport,
} from "../src";

declare const Bun: {
  serve(options: {
    port: number;
    fetch: (request: Request, server: { upgrade(request: Request, options?: { data?: Record<string, unknown> }): boolean }) => Response | Promise<Response> | void | Promise<void>;
    websocket: {
      open?: (...args: Array<any>) => void;
      message?: (...args: Array<any>) => void;
      close?: (...args: Array<any>) => void;
    };
  }): {
    port: number;
    stop(closeActiveConnections?: boolean): void;
  };
};

type OpenSocket = WebSocket & { readyState: number };

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openSocket(url: string): Promise<OpenSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url) as OpenSocket;
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("Socket open failed")), {
      once: true,
    });
  });
}

function sendJson(socket: OpenSocket, body: unknown): void {
  socket.send(JSON.stringify(body));
}

function waitForRpcResponse(socket: OpenSocket, id: string): Promise<any> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent<string>) => {
      const payload = JSON.parse(String(event.data));
      if (payload.id !== id) {
        return;
      }

      socket.removeEventListener("message", listener as EventListener);
      resolve(payload);
    };

    socket.addEventListener("message", listener as EventListener);
  });
}

function waitForFeedChunks(
  socket: OpenSocket,
  hash: string,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const chunks: Array<Record<string, unknown>> = [];
    const listener = (event: MessageEvent<string>) => {
      const payload = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (payload.channel !== "feed" || payload.hash !== hash) {
        return;
      }

      chunks.push(payload);
      if (payload.type === "done") {
        socket.removeEventListener("message", listener as EventListener);
        resolve(chunks);
      }
    };

    socket.addEventListener("message", listener as EventListener);
  });
}

async function createBunHarness(
  router: Record<string, CompiledRoute>,
  options?: {
    security?: ScompTransportSecurityPolicy;
  },
): Promise<{
  transport: BunWebSocketServerTransport;
  server: {
    port: number;
    stop(closeActiveConnections?: boolean): void;
  };
  url: string;
}> {
  const transport = createBunWebSocketServerTransport({
    path: "/ws",
    security: options?.security,
  });
  await transport.listen(router);

  const server = Bun.serve({
    port: 0,
    fetch: transport.fetch as unknown as (
      request: Request,
      server: {
        upgrade(
          request: Request,
          options?: { data?: Record<string, unknown> },
        ): boolean;
      },
    ) => Response | Promise<Response> | void | Promise<void>,
    websocket: transport.websocket,
  });

  return {
    transport,
    server,
    url: `ws://127.0.0.1:${server.port}/ws`,
  };
}

describe("BunWebSocketServerTransport", () => {
  it("boots with Bun.serve and handles request/signal/feed envelopes", async () => {
    const seenSignals: Array<unknown> = [];
    const router: Record<string, CompiledRoute> = {
      "math.double": {
        route: "math.double",
        kind: "request",
        handler: async (value: number) => value * 2,
      },
      "math.notify": {
        route: "math.notify",
        kind: "signal",
        handler: async (payload: unknown) => {
          seenSignals.push(payload);
        },
      },
      "math.count": {
        route: "math.count",
        kind: "feed",
        strategy: "fanout",
        handler: async function* (limit: number) {
          for (let value = 1; value <= limit; value += 1) {
            yield value;
          }
        },
      },
    };

    const harness = await createBunHarness(router);
    const socket = await openSocket(harness.url);

    try {
      const requestId = "req-1";
      const requestResponsePromise = waitForRpcResponse(socket, requestId);
      sendJson(socket, {
        id: requestId,
        route: "math.double",
        op: "request",
        payload: 21,
      });

      const requestResponse = await requestResponsePromise;
      expect(requestResponse.payload).toBe(42);

      sendJson(socket, {
        id: "sig-1",
        route: "math.notify",
        op: "signal",
        payload: { id: 7 },
      });
      await wait(20);
      expect(seenSignals).toEqual([{ id: 7 }]);

      const feedStartId = "feed-start-1";
      const feedStartPromise = waitForRpcResponse(socket, feedStartId);
      sendJson(socket, {
        id: feedStartId,
        route: "math.count",
        op: "feed_start",
        payload: 3,
      });

      const feedStart = await feedStartPromise;
      const hash = String(feedStart.payload?.hash ?? "");
      expect(hash.length).toBeGreaterThan(0);

      const feedChunks = await waitForFeedChunks(socket, hash);
      expect(feedChunks.map((chunk) => chunk.type)).toEqual([
        "next",
        "next",
        "next",
        "done",
      ]);
      expect(
        feedChunks
          .filter((chunk) => chunk.type === "next")
          .map((chunk) => chunk.payload),
      ).toEqual([1, 2, 3]);
    } finally {
      socket.close();
      harness.server.stop(true);
    }
  });

  it("rejects unauthorized inbound requests via security policy", async () => {
    const deniedSignals: Array<unknown> = [];

    const router: Record<string, CompiledRoute> = {
      "secure.echo": {
        route: "secure.echo",
        kind: "request",
        handler: async (payload: unknown) => ({ payload }),
      },
      "secure.signal": {
        route: "secure.signal",
        kind: "signal",
        handler: async (payload: unknown) => {
          deniedSignals.push(payload);
        },
      },
    };

    const harness = await createBunHarness(router, {
      security: {
        authenticate: ({ meta }: { meta?: { auth?: { token?: string } } }) => {
          const auth = meta?.auth as { token?: string } | undefined;
          if (auth?.token === "allow") {
            return { subject: "user:allow" };
          }

          return null;
        },
        authorize: (ctx: { principal?: { subject?: string } }) =>
          ctx.principal?.subject === "user:allow",
      },
    });

    const deniedSocket = await openSocket(harness.url);
    const allowedSocket = await openSocket(harness.url);

    try {
      const deniedRequestId = "denied-req";
      const deniedResponsePromise = waitForRpcResponse(deniedSocket, deniedRequestId);
      sendJson(deniedSocket, {
        id: deniedRequestId,
        route: "secure.echo",
        op: "request",
        payload: { id: 1 },
        meta: { auth: { token: "deny" } },
      });
      const deniedResponse = await deniedResponsePromise;
      expect(String(deniedResponse.error)).toContain("not authorized");

      const allowedRequestId = "allowed-req";
      const allowedResponsePromise = waitForRpcResponse(allowedSocket, allowedRequestId);
      sendJson(allowedSocket, {
        id: allowedRequestId,
        route: "secure.echo",
        op: "request",
        payload: { id: 2 },
        meta: { auth: { token: "allow" } },
      });
      const allowedResponse = await allowedResponsePromise;
      expect(allowedResponse.payload).toEqual({ payload: { id: 2 } });

      sendJson(deniedSocket, {
        id: "denied-signal",
        route: "secure.signal",
        op: "signal",
        payload: { denied: true },
        meta: { auth: { token: "deny" } },
      });
      await wait(20);
      expect(deniedSignals).toEqual([]);
    } finally {
      deniedSocket.close();
      allowedSocket.close();
      harness.server.stop(true);
    }
  });
});
