import type {
  CompiledRoute,
  ITransport,
  ScompClientInvokeOptions,
} from "@scomp/core";
import type {
  ScompTransportPrincipal,
  ScompTransportResponseEnvelope,
} from "@scomp/types";
import { toPrincipalMeta } from "@scomp/transport-shared";
import {
  parseTransportMessage,
  WebSocketServerRuntime,
} from "@scomp/transport-websocket-server-runtime";
import { createBrowserSocketAdapterFactory } from "@scomp/transport-websocket-shared";
import {
  type BunWebSocketServerTransportConfig,
  resolveOutboundTransport,
} from "./shared";

/**
 * Bun's global `WebSocket` is browser-compatible, so the browser
 * adapter works as the default outbound socket factory.
 */
const bunSocketAdapter = createBrowserSocketAdapterFactory();

export type { BunWebSocketServerTransportConfig };

type BunReadyStateOpen = 1;

interface BunLikeServerWebSocket {
  readyState: number;
  data?: BunServerData;
  send(payload: string): void;
  close?(code?: number, reason?: string): void;
  terminate?(): void;
}

interface BunLikeServer {
  stop(closeActiveConnections?: boolean): void;
}

interface BunLikeServeOptions {
  port: number;
  hostname?: string;
  fetch: (
    request: Request,
    server: {
      upgrade(request: Request, options?: { data?: BunServerData }): boolean;
    },
  ) => Response | undefined;
  websocket: {
    open?: (socket: BunLikeServerWebSocket) => void;
    message?: (
      socket: BunLikeServerWebSocket,
      data: string | Buffer | ArrayBuffer | Uint8Array,
    ) => void;
    close?: (socket: BunLikeServerWebSocket) => void;
  };
}

declare const Bun: {
  serve(options: BunLikeServeOptions): BunLikeServer;
};

type BunServerData = {
  principal?: ScompTransportPrincipal;
};

type BunSocketWithState = BunLikeServerWebSocket & { data: BunServerData };

function toFeedExchange(hash: string): string {
  return `scomp.live.${hash}`;
}

function toText(data: string | Buffer | ArrayBuffer | Uint8Array): string {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

function ensureSocketState(socket: BunLikeServerWebSocket): BunSocketWithState {
  const withState = socket as BunSocketWithState;
  withState.data = withState.data ?? {};
  return withState;
}

export class BunWebSocketServerTransport implements ITransport {
  private readonly config: BunWebSocketServerTransportConfig;
  private server?: BunLikeServer;
  private readonly sockets = new Set<BunSocketWithState>();
  private outboundTransport?: ITransport;
  private readonly runtime: WebSocketServerRuntime<BunSocketWithState>;

  constructor(config: BunWebSocketServerTransportConfig) {
    this.config = config;
    this.runtime = new WebSocketServerRuntime<BunSocketWithState>({
      security: this.config.security,
      getSocketPrincipal: (socket) => socket.data?.principal,
      setSocketPrincipal: (socket, principal) => {
        socket.data = {
          ...(socket.data ?? {}),
          principal,
        };
      },
      invokeRoute: async (route, message) => {
        const rawPayload = message.payload;
        const payload = route.parser ? route.parser(rawPayload) : rawPayload;
        return route.handler(payload);
      },
      isSocketOpen: (socket) => socket.readyState === (1 as BunReadyStateOpen),
      onReply: (socket, response: ScompTransportResponseEnvelope) => {
        socket.send(JSON.stringify(response));
      },
      onFeedChunk: (socket, chunk) => {
        socket.send(JSON.stringify(chunk));
      },
      onFeedExchange: toFeedExchange,
      toPrincipalMeta,
    });
  }

  async registerRoutes(router: Record<string, CompiledRoute>): Promise<void> {
    this.runtime.setRouter(router);
    if (this.server) {
      return;
    }

    if (!this.config.port) {
      throw new Error(
        "BunWebSocketServerTransport requires a port for Bun.serve.",
      );
    }

    const expectedPath = this.config.path ?? "/";

    this.server = Bun.serve({
      port: this.config.port,
      hostname: this.config.host,
      fetch: (request, server) => {
        const url = new URL(request.url);
        if (url.pathname !== expectedPath) {
          return new Response("Not found", { status: 404 });
        }

        const upgraded = server.upgrade(request, { data: {} });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        return undefined;
      },
      websocket: {
        open: (socket: BunLikeServerWebSocket) => {
          this.sockets.add(ensureSocketState(socket));
        },
        message: (socket: BunLikeServerWebSocket, data) => {
          const socketWithState = ensureSocketState(socket);
          const body = parseTransportMessage(toText(data));
          if (!body) {
            return;
          }
          void this.runtime.handleIncoming(socketWithState, body);
        },
        close: (socket: BunLikeServerWebSocket) => {
          const socketWithState = ensureSocketState(socket);
          this.runtime.detachSocketFromFeeds(socketWithState);
          this.sockets.delete(socketWithState);
        },
      },
    });
  }

  async close(): Promise<void> {
    if (this.outboundTransport) {
      await this.outboundTransport.close();
      this.outboundTransport = undefined;
    }

    for (const socket of this.sockets) {
      this.runtime.detachSocketFromFeeds(socket);
      socket.terminate?.();
      socket.close?.();
    }
    this.sockets.clear();

    this.server?.stop(true);
    this.server = undefined;
  }

  async request(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<unknown> {
    return this.getOutboundTransport().request(route, payload, options);
  }

  async signal(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<void> {
    await this.getOutboundTransport().signal(route, payload, options);
  }

  feed(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<unknown> {
    return this.getOutboundTransport().feed(route, payload, options);
  }

  private getOutboundTransport(): ITransport {
    this.outboundTransport = resolveOutboundTransport(
      this.config,
      this.outboundTransport,
      bunSocketAdapter,
    );
    return this.outboundTransport;
  }
}

export function createBunWebSocketServerTransport(
  config: BunWebSocketServerTransportConfig,
): BunWebSocketServerTransport {
  return new BunWebSocketServerTransport(config);
}

/**
 * @deprecated Use `BunWebSocketServerTransport` instead.
 */
export const WebSocketServerTransport = BunWebSocketServerTransport;

/**
 * @deprecated Use `BunWebSocketServerTransportConfig` instead.
 */
export type WebSocketServerTransportConfig = BunWebSocketServerTransportConfig;

/**
 * @deprecated Use `createBunWebSocketServerTransport` instead.
 */
export const createWebSocketServerTransport =
  createBunWebSocketServerTransport;
