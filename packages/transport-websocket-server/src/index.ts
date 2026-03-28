import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { CompiledRoute, ITransport } from '@scomp/core';
import {
  createFeedHash,
  type ScompFeedChunkEnvelope,
  type ScompTransportRequestEnvelope,
  type ScompTransportResponseEnvelope
} from '@scomp/types';
import {
  WebSocketClientTransport,
  type WebSocketClientTransportConfig
} from '@scomp/transport-websocket-client';
import WebSocket, { type RawData, WebSocketServer } from 'ws';

export class StreamClosedError extends Error {
  constructor(streamHash: string) {
    super(`Feed stream closed for hash: ${streamHash}`);
    this.name = 'StreamClosedError';
  }
}

interface RunningFeed {
  key: string;
  exchange: string;
  subscribers: Set<WebSocket>;
  abortController: AbortController;
}

type TransportMessage = ScompTransportRequestEnvelope;

export interface WebSocketServerTransportConfig {
  port?: number;
  host?: string;
  path?: string;
  server?: HttpServer | HttpsServer;
  outbound?: WebSocketClientTransportConfig | WebSocketClientTransport;
}

type RouterTable = Record<string, CompiledRoute>;

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function toText(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }

  return Buffer.from(data).toString('utf8');
}

function toFeedExchange(hash: string): string {
  return `scomp.live.${hash}`;
}

function ensureFeedIterable(value: unknown): AsyncIterable<unknown> {
  if (value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    return value as AsyncIterable<unknown>;
  }

  throw new Error('Feed route handler did not return an AsyncIterable.');
}

export class WebSocketServerTransport implements ITransport {
  private readonly config: WebSocketServerTransportConfig;
  private server?: WebSocketServer;
  private router?: RouterTable;
  private readonly sockets = new Set<WebSocket>();
  private readonly runningFeeds = new Map<string, RunningFeed>();
  private outboundTransport?: ITransport;

  constructor(config: WebSocketServerTransportConfig) {
    this.config = config;
  }

  async listen(router: RouterTable): Promise<void> {
    this.router = router;
    const server = this.getServer();

    if (server.listenerCount('connection') > 0) {
      return;
    }

    server.on('connection', (socket: WebSocket) => {
      this.sockets.add(socket);

      socket.on('message', async (data: RawData) => {
        const body = safeJsonParse(toText(data)) as TransportMessage;
        await this.handleIncoming(socket, body);
      });

      socket.on('close', () => {
        this.detachSocketFromFeeds(socket);
        this.sockets.delete(socket);
      });

      socket.on('error', () => {
        this.detachSocketFromFeeds(socket);
        this.sockets.delete(socket);
      });
    });
  }

  async request(route: string, payload: any): Promise<any> {
    const transport = this.getOutboundTransport();
    return transport.request(route, payload);
  }

  async signal(route: string, payload: any): Promise<void> {
    const transport = this.getOutboundTransport();
    await transport.signal(route, payload);
  }

  feed(route: string, payload: any): AsyncIterable<any> {
    const transport = this.getOutboundTransport();
    return transport.feed(route, payload);
  }

  private getOutboundTransport(): ITransport {
    if (this.outboundTransport) {
      return this.outboundTransport;
    }

    const outboundConfig = this.config.outbound;
    if (!outboundConfig) {
      throw new Error(
        'WebSocketServerTransport outbound is not configured. Provide config.outbound to use request/signal/feed.'
      );
    }

    this.outboundTransport = outboundConfig instanceof WebSocketClientTransport
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
        path: this.config.path
      });
      return this.server;
    }

    if (!this.config.port) {
      throw new Error('WebSocketServerTransport requires either a port or an existing HTTP server.');
    }

    this.server = new WebSocketServer({
      port: this.config.port,
      host: this.config.host,
      path: this.config.path
    });

    return this.server;
  }

  private async handleIncoming(socket: WebSocket, body: TransportMessage): Promise<void> {
    const routeName = String(body.route ?? '');
    const routeEntry = this.router?.[routeName];
    const op = body.op ?? 'request';

    if (!routeEntry) {
      if (body.id) {
        this.replyWithError(socket, body.id, `Route not found: ${routeName}`);
      }
      return;
    }

    if (routeEntry.kind === 'feed') {
      await this.handleFeedRpc(socket, routeEntry, body, op);
      return;
    }

    if (op === 'signal' || routeEntry.kind === 'signal') {
      try {
        await this.invokeRoute(routeEntry, body);
      } catch {
        // Signals are fire-and-forget and do not reply.
      }
      return;
    }

    try {
      const result = await this.invokeRoute(routeEntry, body);
      this.replyWithPayload(socket, body.id, result);
    } catch (error) {
      this.replyWithError(socket, body.id, error);
    }
  }

  private async handleFeedRpc(
    socket: WebSocket,
    route: CompiledRoute,
    body: TransportMessage,
    op: string
  ): Promise<void> {
    const rawPayload = body.payload;
    const parsedPayload = route.parser ? route.parser(rawPayload) : rawPayload;
    const payloadRecord = body.payload && typeof body.payload === 'object'
      ? body.payload as { hash?: unknown }
      : undefined;
    const hash = String(payloadRecord?.hash ?? createFeedHash(route.route, parsedPayload, { hashKey: route.hashKey }));

    if (op === 'feed_stop') {
      const running = this.runningFeeds.get(hash);
      if (running) {
        running.subscribers.delete(socket);
        if (running.subscribers.size === 0) {
          running.abortController.abort(new StreamClosedError(hash));
        }
      }

      this.replyWithPayload(socket, body.id, { ok: true });
      return;
    }

    const existing = this.runningFeeds.get(hash);
    if (existing) {
      existing.subscribers.add(socket);
      this.replyWithPayload(socket, body.id, { exchange: existing.exchange, hash });
      return;
    }

    const runningFeed: RunningFeed = {
      key: hash,
      exchange: toFeedExchange(hash),
      subscribers: new Set([socket]),
      abortController: new AbortController()
    };

    this.runningFeeds.set(hash, runningFeed);
    this.replyWithPayload(socket, body.id, {
      exchange: runningFeed.exchange,
      hash
    });

    const iterable = ensureFeedIterable(route.handler(parsedPayload));
    setImmediate(() => {
      void this.publishFeed(runningFeed, iterable);
    });
  }

  private async publishFeed(runningFeed: RunningFeed, iterable: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const chunk of iterable) {
        if (runningFeed.abortController.signal.aborted) {
          throw runningFeed.abortController.signal.reason;
        }

        this.broadcastFeedChunk(runningFeed, {
          hash: runningFeed.key,
          type: 'next',
          payload: chunk
        });
      }

      this.broadcastFeedChunk(runningFeed, {
        hash: runningFeed.key,
        type: 'done'
      });
    } catch (error) {
      this.broadcastFeedChunk(runningFeed, {
        hash: runningFeed.key,
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.runningFeeds.delete(runningFeed.key);
    }
  }

  private broadcastFeedChunk(runningFeed: RunningFeed, chunk: { hash: string; type: 'next' | 'done' | 'error'; payload?: unknown; message?: string }): void {
    const payload = JSON.stringify({
      channel: 'feed',
      ...chunk
    } satisfies ScompFeedChunkEnvelope);

    for (const socket of runningFeed.subscribers) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      socket.send(payload);
    }
  }

  private detachSocketFromFeeds(socket: WebSocket): void {
    for (const runningFeed of this.runningFeeds.values()) {
      if (!runningFeed.subscribers.has(socket)) {
        continue;
      }

      runningFeed.subscribers.delete(socket);
      if (runningFeed.subscribers.size === 0) {
        runningFeed.abortController.abort(new StreamClosedError(runningFeed.key));
      }
    }
  }

  private async invokeRoute(route: CompiledRoute, message: TransportMessage): Promise<unknown> {
    const rawPayload = message.payload;
    const payload = route.parser ? route.parser(rawPayload) : rawPayload;
    return route.handler(payload);
  }

  private replyWithPayload(socket: WebSocket, id: string | undefined, payload: unknown): void {
    if (!id || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({ id, payload } satisfies ScompTransportResponseEnvelope));
  }

  private replyWithError(socket: WebSocket, id: string | undefined, error: unknown): void {
    if (!id || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        id,
        error: error instanceof Error ? error.message : String(error)
      } satisfies ScompTransportResponseEnvelope)
    );
  }
}

export function createWebSocketServerTransport(config: WebSocketServerTransportConfig): WebSocketServerTransport {
  return new WebSocketServerTransport(config);
}
