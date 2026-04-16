import { type SocketAdapterFactory } from "@scomp/transport-websocket-shared";
import {
  WebSocketClientTransport,
  type WebSocketClientTransportConfig,
} from "@scomp/transport-websocket-client";
import type { ITransport } from "@scomp/core";

/**
 * Outbound client config with an optional socketAdapter.
 * When omitted, the runtime-specific server module supplies a default.
 */
export type OutboundClientConfig = Omit<
  WebSocketClientTransportConfig,
  "socketAdapter"
> & {
  socketAdapter?: SocketAdapterFactory;
};

export interface WebSocketServerTransportBaseConfig {
  host?: string;
  path?: string;
  outbound?: OutboundClientConfig | WebSocketClientTransport;
}

export interface BunWebSocketServerTransportConfig
  extends WebSocketServerTransportBaseConfig {
  port: number;
}

export interface NodeWebSocketServerTransportConfig
  extends WebSocketServerTransportBaseConfig {
  port?: number;
  server?: import("node:http").Server | import("node:https").Server;
}

export function resolveOutboundTransport(
  config: WebSocketServerTransportBaseConfig,
  existing: ITransport | undefined,
  defaultSocketAdapter: SocketAdapterFactory,
): ITransport {
  if (existing) return existing;

  const outboundConfig = config.outbound;
  if (!outboundConfig) {
    throw new Error(
      "WebSocketServerTransport outbound not configured. Provide config.outbound.",
    );
  }

  if (outboundConfig instanceof WebSocketClientTransport) {
    return outboundConfig;
  }

  return new WebSocketClientTransport({
    ...outboundConfig,
    socketAdapter: outboundConfig.socketAdapter ?? defaultSocketAdapter,
  });
}
