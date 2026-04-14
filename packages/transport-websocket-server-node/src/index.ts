import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type {
  CompiledRoute,
  ITransport,
  ScompClientInvokeOptions,
} from "@scomp/core";
import type {
  ScompTransportPrincipal,
  ScompTransportRequestEnvelope,
  ScompTransportResponseEnvelope,
  ScompTransportSecurityPolicy,
  ScompFeedChunkEnvelope,
  ScompTransportMessageMeta,
} from "@scomp/types";
import { toPrincipalMeta } from "@scomp/transport-shared";
import {
  parseTransportMessage,
  StreamClosedError,
  WebSocketServerRuntime,
} from "@scomp/transport-websocket-server-runtime";
import {
  WebSocketClientTransport,
  type WebSocketClientTransportConfig,
} from "@scomp/transport-websocket-client";
import WebSocket, { type RawData, WebSocketServer } from "ws";

export { StreamClosedError };

interface SocketWithPrincipal extends WebSocket {
  scompPrincipal?: ScompTransportPrincipal;
}

type RouterTable = Record<string, CompiledRoute>;

type TransportMessage = ScompTransportRequestEnvelope;

export interface WebSocketServerTransportConfig {
  port?: number;
  host?: string;
  path?: string;
  server?: HttpServer | HttpsServer;
  outbound?: WebSocketClientTransportConfig | WebSocketClientTransport;
  security?: ScompTransportSecurityPolicy;
}

function toFeedExchange(hash: string): string {
  return `scomp.live.${hash}`;
}

function toText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

export class WebSocketServerTransport implements ITransport {
  private readonly config: WebSocketServerTransportConfig;
  private server?: WebSocketServer;
  private readonly sockets = new Set<SocketWithPrincipal>();
  private outboundTransport?: ITransport;
  private readonly runtime: WebSocketServerRuntime<SocketWithPrincipal>;

  constructor(config: WebSocketServerTransportConfig) {
    this.config = config;
    this.runtime = new WebSocketServerRuntime<SocketWithPrincipal>({
      security: this.config.security,
      getSocketPrincipal: (socket: SocketWithPrincipal) =>
        socket.scompPrincipal,
      setSocketPrincipal: (
        socket: SocketWithPrincipal,
        principal: ScompTransportPrincipal,
      ) => {
        socket.scompPrincipal = principal;
      },
      invokeRoute: async (
        route: CompiledRoute,
        message: ScompTransportRequestEnvelope,
      ) => {
        const rawPayload = message.payload;
        const payload = route.parser ? route.parser(rawPayload) : rawPayload;
        return route.handler(payload);
      },
      isSocketOpen: (socket: SocketWithPrincipal) =>
        socket.readyState === WebSocket.OPEN,
      onReply: (
        socket: SocketWithPrincipal,
        response: ScompTransportResponseEnvelope,
      ) => {
        socket.send(JSON.stringify(response));
      },
      onFeedChunk: (
        socket: SocketWithPrincipal,
        chunk: ScompFeedChunkEnvelope,
      ) => {
        socket.send(JSON.stringify(chunk));
      },
      onFeedExchange: toFeedExchange,
      toPrincipalMeta,
    });
  }

  async registerRoutes(router: RouterTable): Promise<void> {
    this.runtime.setRouter(router);
    const server = this.getServer();

    if (server.listenerCount("connection") > 0) {
      return;
    }

    server.on("connection", (socket: WebSocket) => {
      const socketWithPrincipal = socket as SocketWithPrincipal;
      this.sockets.add(socketWithPrincipal);

      socket.on("message", async (data: RawData) => {
        const body = parseTransportMessage(toText(data));
        if (!body) {
          return;
        }
        await this.runtime.handleIncoming(socketWithPrincipal, body);
      });

      socket.on("close", () => {
        this.runtime.detachSocketFromFeeds(socketWithPrincipal);
        this.sockets.delete(socketWithPrincipal);
      });

      socket.on("error", () => {
        this.runtime.detachSocketFromFeeds(socketWithPrincipal);
        this.sockets.delete(socketWithPrincipal);
      });
    });
  }

  async close(): Promise<void> {
    if (this.outboundTransport) {
      await this.outboundTransport.close();
      this.outboundTransport = undefined;
    }

    for (const socket of this.sockets) {
      this.runtime.detachSocketFromFeeds(socket);
      socket.terminate();
      socket.close();
    }
    this.sockets.clear();

    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
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

  private getServer(): WebSocketServer {
    if (this.server) {
      return this.server;
    }

    if (this.config.server) {
      this.server = new WebSocketServer({
        server: this.config.server,
        path: this.config.path,
      });
      return this.server;
    }

    if (!this.config.port) {
      throw new Error(
        "WebSocketServerTransport requires either a port or an existing HTTP server.",
      );
    }

    this.server = new WebSocketServer({
      port: this.config.port,
      host: this.config.host,
      path: this.config.path,
    });

    return this.server;
  }
}

export function createWebSocketServerTransport(
  config: WebSocketServerTransportConfig,
): WebSocketServerTransport {
  return new WebSocketServerTransport(config);
}
