import type { CompiledRoute, ControlledAsyncIterable, ScompHandlerContext } from "@scomp/core";
import type {
  ScompFeedChunkEnvelope,
  ScompTransportMessageMeta,
  ScompTransportPrincipal,
  ScompTransportRequestEnvelope,
  ScompTransportResponseEnvelope,
} from "@scomp/types";
import { safeJsonParse } from "@scomp/transport-shared";

export class StreamClosedError extends Error {
  constructor(streamHash: string) {
    super(`Feed stream closed for hash: ${streamHash}`);
    this.name = "StreamClosedError";
  }
}

export interface RuntimeSocket {
  readyState: number;
  send(payload: string): void;
}

export interface RunningFeed<Socket extends RuntimeSocket> {
  key: string;
  exchange: string;
  subscribers: Set<Socket>;
  abortController: AbortController;
  controller?: Record<string, (payload: unknown) => unknown>;
}

export type TransportMessage = ScompTransportRequestEnvelope;

export type RuntimeHandlers<Socket extends RuntimeSocket> = {
  invokeRoute: (
    route: CompiledRoute,
    message: TransportMessage,
    ctx?: ScompHandlerContext,
  ) => Promise<unknown>;
  isSocketOpen: (socket: Socket) => boolean;
  onReply: (socket: Socket, response: ScompTransportResponseEnvelope) => void;
  onFeedChunk: (socket: Socket, chunk: ScompFeedChunkEnvelope) => void;
  onFeedExchange: (hash: string) => string;
};

export type WebSocketServerRuntimeConfig<Socket extends RuntimeSocket> =
  RuntimeHandlers<Socket>;

export function parseTransportMessage(
  text: string,
): TransportMessage | undefined {
  const parsed = safeJsonParse(text);
  if (!parsed.ok) {
    return undefined;
  }
  return parsed.value as TransportMessage;
}

export function ensureFeedIterable(value: unknown): AsyncIterable<unknown> {
  if (
    value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  ) {
    return value as AsyncIterable<unknown>;
  }

  throw new Error("Feed route handler did not return an AsyncIterable.");
}

export function isControlledAsyncIterable(
  value: unknown,
): value is ControlledAsyncIterable<unknown, Record<string, Function>> {
  return (
    value != null &&
    typeof (value as ControlledAsyncIterable<unknown>).controller ===
      "object" &&
    (value as ControlledAsyncIterable<unknown>).controller !== null
  );
}
