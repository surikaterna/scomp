import type {
  CompiledRoute,
  ITransport,
  ScompClientInvokeOptions,
} from "@scomp/core";
import {
  type ScompTransportPrincipal,
  type ScompTransportSecurityPolicy,
  type ScompTransportMessageMeta,
  type ScompTransportResponseEnvelope,
} from "@scomp/types";
import {
  parseTransportMessage,
  StreamClosedError,
  WebSocketServerRuntime,
} from "@scomp/transport-websocket-server-runtime";
import {
  WebSocketClientTransport,
  type WebSocketClientTransportConfig,
} from "@scomp/transport-websocket-client";

export { StreamClosedError };

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

export interface WebSocketServerTransportConfig {
  port: number;
  host?: string;
  path?: string;
  outbound?: WebSocketClientTransportConfig | WebSocketClientTransport;
  security?: ScompTransportSecurityPolicy;
}

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

function toPrincipalMeta(
  principal: ScompTransportPrincipal | undefined,
): ScompTransportMessageMeta | undefined {
  if (!principal) {
    return undefined;
  }

  return {
    auth: {
      subject: principal.subject,
      tenantId: principal.tenantId,
      scopes: principal.scopes,
      claims: principal.claims,
      issuedAt: principal.issuedAt,
      expiresAt: principal.expiresAt,
      authType: principal.authType,
    },
    tenantId: principal.tenantId,
  };
}

function ensureSocketState(socket: BunLikeServerWebSocket): BunSocketWithState {
  const withState = socket as BunSocketWithState;
  withState.data = withState.data ?? {};
  return withState;
}

export class WebSocketServerTransport implements ITransport {
  private readonly config: WebSocketServerTransportConfig;
  private server?: BunLikeServer;
  private readonly sockets = new Set<BunSocketWithState>();
  private outboundTransport?: ITransport;
  private readonly runtime: WebSocketServerRuntime<BunSocketWithState>;

  constructor(config: WebSocketServerTransportConfig) {
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
        "WebSocketServerTransport requires a port for Bun.serve.",
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

        const upgraded = server.upgrade(request, {
          data: {},
        });

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
    payload: any,
    options?: ScompClientInvokeOptions,
  ): Promise<any> {
    const transport = this.getOutboundTransport();
    return transport.request(route, payload, options);
  }

  async signal(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): Promise<void> {
    const transport = this.getOutboundTransport();
    await transport.signal(route, payload, options);
  }

  feed(
    route: string,
    payload: any,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<any> {
    const transport = this.getOutboundTransport();
    return transport.feed(route, payload, options);
  }

  private getOutboundTransport(): ITransport {
    if (this.outboundTransport) {
      return this.outboundTransport;
    }

    const outboundConfig = this.config.outbound;
    if (!outboundConfig) {
      throw new Error(
        "WebSocketServerTransport outbound is not configured. Provide config.outbound to use request/signal/feed.",
      );
    }

    this.outboundTransport =
      outboundConfig instanceof WebSocketClientTransport
        ? outboundConfig
        : new WebSocketClientTransport(outboundConfig);

    return this.outboundTransport;
  }
}

export function createWebSocketServerTransport(
  config: WebSocketServerTransportConfig,
): WebSocketServerTransport {
  return new WebSocketServerTransport(config);
}
