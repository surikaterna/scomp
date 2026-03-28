export type ScompTransportOperation =
  | 'request'
  | 'signal'
  | 'feed_start'
  | 'feed_stop';

export interface ScompTransportRequest {
  route: string;
  op: ScompTransportOperation;
  payload?: unknown;
}

export interface ScompTransportSuccessResponse {
  payload?: unknown;
}

export interface ScompTransportErrorResponse {
  error: string;
}

export type ScompTransportResponse = ScompTransportSuccessResponse | ScompTransportErrorResponse;

export type ScompFeedChunkType = 'next' | 'done' | 'error';

export interface ScompFeedChunk {
  type: ScompFeedChunkType;
  payload?: unknown;
  message?: string;
}

export interface ScompSerializer {
  stringify(value: unknown): string;
  parse<T = unknown>(text: string): T;
  contentType?: string;
}
