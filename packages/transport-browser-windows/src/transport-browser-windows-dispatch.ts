import type {
  BrowserWindowsHostFeedStartMessage,
  BrowserWindowsHostFeedStopMessage,
  BrowserWindowsHostRequestMessage,
  BrowserWindowsHostSignalMessage,
  BrowserWindowsInvokeFeedChunkMessage,
  BrowserWindowsInvokeResponseMessage,
  BrowserWindowsProtocolMessage,
} from "./protocol";

export interface BrowserWindowsMessageHandlers {
  invokeResponse(message: BrowserWindowsInvokeResponseMessage): void;
  invokeFeedChunk(message: BrowserWindowsInvokeFeedChunkMessage): void;
  hostRequest(message: BrowserWindowsHostRequestMessage): void;
  hostSignal(message: BrowserWindowsHostSignalMessage): void;
  hostFeedStart(message: BrowserWindowsHostFeedStartMessage): void;
  hostFeedStop(message: BrowserWindowsHostFeedStopMessage): void;
}

export function dispatchIncomingMessage(
  participantId: string,
  message: BrowserWindowsProtocolMessage,
  handlers: BrowserWindowsMessageHandlers,
): void {
  if (message.targetId && message.targetId !== participantId) {
    return;
  }

  switch (message.type) {
    case "invoke_response":
      handlers.invokeResponse(message);
      return;
    case "invoke_feed_chunk":
      handlers.invokeFeedChunk(message);
      return;
    case "host_request":
      handlers.hostRequest(message);
      return;
    case "host_signal":
      handlers.hostSignal(message);
      return;
    case "host_feed_start":
      handlers.hostFeedStart(message);
      return;
    case "host_feed_stop":
      handlers.hostFeedStop(message);
      return;
    default:
      return;
  }
}
