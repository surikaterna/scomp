import type { BrowserWindowsInvokeFeedChunkMessage, BrowserWindowsInvokeResponseMessage } from "./protocol";
import { handleInvokeFeedChunkMessage, handleInvokeResponseMessage } from "./transport-browser-windows-client";
import type { FeedQueueState, PendingRequestState } from "./transport-browser-windows-state";
import type {
  BrowserWindowsRequestId,
  BrowserWindowsTransportHealthReasonCode,
  BrowserWindowsTransportHealthStatus,
} from "./types";

type HealthReporter = (
  code: BrowserWindowsTransportHealthReasonCode,
  detail: string | undefined,
  status: BrowserWindowsTransportHealthStatus,
) => void;

export function processInvokeResponse(
  pendingRequests: Map<BrowserWindowsRequestId, PendingRequestState>,
  message: BrowserWindowsInvokeResponseMessage,
  reportHealth: HealthReporter,
): void {
  handleInvokeResponseMessage(pendingRequests, message, reportHealth);
}

export function processInvokeFeedChunk(
  feedStates: Map<BrowserWindowsRequestId, FeedQueueState>,
  message: BrowserWindowsInvokeFeedChunkMessage,
  maxBufferedFeedChunksPerSubscriber: number,
  participantId: string,
  postMessage: (message: unknown) => void,
  reportHealth: HealthReporter,
): void {
  handleInvokeFeedChunkMessage(
    feedStates,
    message,
    maxBufferedFeedChunksPerSubscriber,
    participantId,
    postMessage,
    reportHealth,
  );
}
