import type { CompiledRoute, ITransport, ScompClientInvokeOptions } from "@scompr/core";
import { parseTransportMessage, WebSocketServerRuntime } from "@scompr/transport-websocket-server-runtime";
import { createNodeSocketAdapterFactory } from "@scompr/transport-websocket-shared";
import type {
  ScompFeedChunkEnvelope,
  ScompTransportRequestEnvelope,
  ScompTransportResponseEnvelope,
} from "@scompr/types";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { type NodeWebSocketServerTransportConfig, resolveOutboundTransport } from "./shared";

const nodeSocketAdapter = createNodeSocketAdapterFactory();

export type { NodeWebSocketServerTransportConfig };

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

export class NodeWebSocketServerTransport implements ITransport {
  private readonly config: NodeWebSocketServerTransportConfig;
  private server?: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private outboundTransport?: ITransport;
  private readonly runtime: WebSocketServerRuntime<WebSocket>;

  constructor(config: NodeWebSocketServerTransportConfig) {
    this.config = config;
    this.runtime = new WebSocketServerRuntime<WebSocket>({
      invokeRoute: async (route: CompiledRoute, message: ScompTransportRequestEnvelope, ctx) => {
        const rawPayload = message.payload;
        const payload = route.parser ? route.parser(rawPayload) : rawPayload;
        return route.handler(payload, ctx);
      },
      isSocketOpen: (socket: WebSocket) => socket.readyState === WebSocket.OPEN,
      onReply: (socket: WebSocket, response: ScompTransportResponseEnvelope) => {
        socket.send(JSON.stringify(response));
      },
      onFeedChunk: (socket: WebSocket, chunk: ScompFeedChunkEnvelope) => {
        socket.send(JSON.stringify(chunk));
      },
      onFeedExchange: toFeedExchange,
    });
  }

  async registerRoutes(router: Record<string, CompiledRoute>): Promise<void> {
    this.runtime.setRouter(router);
    const server = this.getServer();

    if (server.listenerCount("connection") > 0) {
      return;
    }

    server.on("connection", (socket: WebSocket) => {
      this.sockets.add(socket);

      socket.on("message", async (data: RawData) => {
        const body = parseTransportMessage(toText(data));
        if (!body) {
          return;
        }
        await this.runtime.handleIncoming(socket, body);
      });

      socket.on("close", () => {
        this.runtime.detachSocketFromFeeds(socket);
        this.sockets.delete(socket);
      });

      socket.on("error", () => {
        this.runtime.detachSocketFromFeeds(socket);
        this.sockets.delete(socket);
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

  async invoke(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<unknown> {
    return this.getOutboundTransport().invoke(route, payload, options);
  }

  private getOutboundTransport(): ITransport {
    this.outboundTransport = resolveOutboundTransport(this.config, this.outboundTransport, nodeSocketAdapter);
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
      throw new Error("NodeWebSocketServerTransport requires either a port or an existing HTTP server.");
    }

    this.server = new WebSocketServer({
      port: this.config.port,
      host: this.config.host,
      path: this.config.path,
    });

    return this.server;
  }
}

export function createNodeWebSocketServerTransport(
  config: NodeWebSocketServerTransportConfig,
): NodeWebSocketServerTransport {
  return new NodeWebSocketServerTransport(config);
}

/**
 * @deprecated Use `NodeWebSocketServerTransport` instead.
 */
export const WebSocketServerTransport = NodeWebSocketServerTransport;

/**
 * @deprecated Use `NodeWebSocketServerTransportConfig` instead.
 */
export type WebSocketServerTransportConfig = NodeWebSocketServerTransportConfig;

/**
 * @deprecated Use `createNodeWebSocketServerTransport` instead.
 */
export const createWebSocketServerTransport = createNodeWebSocketServerTransport;
