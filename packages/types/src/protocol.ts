import { createHash } from 'node:crypto';

export type ScompTransportOperation =
  | 'request'
  | 'signal'
  | 'feed_start'
  | 'feed_stop';

export interface ScompTransportRequestEnvelope {
  id?: string;
  route: string;
  op: ScompTransportOperation;
  payload?: unknown;
}

export type ScompTransportRequest = ScompTransportRequestEnvelope;

export interface ScompTransportSuccessResponseEnvelope {
  id?: string;
  payload?: unknown;
}

export interface ScompTransportErrorResponseEnvelope {
  id?: string;
  error: string;
}

export type ScompTransportSuccessResponse = ScompTransportSuccessResponseEnvelope;

export type ScompTransportErrorResponse = ScompTransportErrorResponseEnvelope;

export type ScompTransportResponseEnvelope = ScompTransportSuccessResponseEnvelope | ScompTransportErrorResponseEnvelope;

export type ScompTransportResponse = ScompTransportResponseEnvelope;

export type ScompFeedChunkType = 'next' | 'done' | 'error';

export interface ScompFeedChunkEnvelope {
  channel: 'feed';
  hash: string;
  type: ScompFeedChunkType;
  payload?: unknown;
  message?: string;
}

export type ScompFeedChunk = ScompFeedChunkEnvelope;

export interface FeedHashOptions {
  hashKey?: (payload: unknown) => string;
  stringify?: (value: unknown) => string;
}

export function createFeedHash(route: string, payload: unknown, options: FeedHashOptions = {}): string {
  if (options.hashKey) {
    return options.hashKey(payload);
  }

  const stringify = options.stringify ?? JSON.stringify;
  const serialized = stringify(payload ?? {});
  return createHash('sha256').update(`${route}:${serialized}`).digest('hex').slice(0, 32);
}

export interface ScompSerializer {
  stringify(value: unknown): string;
  parse<T = unknown>(text: string): T;
  contentType?: string;
}
