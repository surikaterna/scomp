import type {
  ScompFeedChunkType,
  ScompTransportMessageMeta,
  ScompTransportOperation,
} from "@scomp/types";
import type {
  BrowserWindowsCanonicalPayloadHash,
  BrowserWindowsParticipantId,
  BrowserWindowsPayloadKey,
  BrowserWindowsRequestId,
} from "./types";

export type BrowserWindowsProtocolMessageType =
  | "hello"
  | "hello_ack"
  | "participant_disconnect"
  | "heartbeat"
  | "routes_register"
  | "routes_unregister"
  | "invoke_request"
  | "invoke_signal"
  | "invoke_feed_start"
  | "invoke_feed_stop"
  | "host_request"
  | "host_signal"
  | "host_feed_start"
  | "host_feed_stop"
  | "host_response"
  | "host_feed_started"
  | "host_feed_chunk"
  | "invoke_response"
  | "invoke_feed_chunk";

export interface BrowserWindowsProtocolEnvelopeBase {
  type: BrowserWindowsProtocolMessageType;
  sourceId: BrowserWindowsParticipantId;
  targetId?: BrowserWindowsParticipantId;
  sentAtMs: number;
  meta?: ScompTransportMessageMeta;
}

export interface BrowserWindowsHelloMessage extends BrowserWindowsProtocolEnvelopeBase {
  type: "hello";
}

export interface BrowserWindowsHelloAckMessage extends BrowserWindowsProtocolEnvelopeBase {
  type: "hello_ack";
}

export interface BrowserWindowsParticipantDisconnectMessage extends BrowserWindowsProtocolEnvelopeBase {
  type: "participant_disconnect";
}

export interface BrowserWindowsHeartbeatMessage extends BrowserWindowsProtocolEnvelopeBase {
  type: "heartbeat";
}

export interface BrowserWindowsRoutesRegisterMessage extends BrowserWindowsProtocolEnvelopeBase {
  type: "routes_register";
  routes: Array<string>;
}

export interface BrowserWindowsRoutesUnregisterMessage extends BrowserWindowsProtocolEnvelopeBase {
  type: "routes_unregister";
  routes: Array<string>;
}

interface BrowserWindowsProtocolInvokeBase extends BrowserWindowsProtocolEnvelopeBase {
  requestId: BrowserWindowsRequestId;
  route: string;
}

export interface BrowserWindowsInvokeRequestMessage extends BrowserWindowsProtocolInvokeBase {
  type: "invoke_request";
  operation: Extract<ScompTransportOperation, "request">;
  payload: unknown;
}

export interface BrowserWindowsInvokeSignalMessage extends BrowserWindowsProtocolInvokeBase {
  type: "invoke_signal";
  operation: Extract<ScompTransportOperation, "signal">;
  payload: unknown;
}

export interface BrowserWindowsInvokeFeedStartMessage extends BrowserWindowsProtocolInvokeBase {
  type: "invoke_feed_start";
  operation: Extract<ScompTransportOperation, "feed">;
  payload: unknown;
  payloadKey: BrowserWindowsPayloadKey;
  payloadHash: BrowserWindowsCanonicalPayloadHash;
}

export interface BrowserWindowsInvokeFeedStopMessage extends BrowserWindowsProtocolInvokeBase {
  type: "invoke_feed_stop";
  operation: Extract<ScompTransportOperation, "signal">;
  method: "__scomp.unsubscribe";
  payloadKey: BrowserWindowsPayloadKey;
  payloadHash: BrowserWindowsCanonicalPayloadHash;
}

interface BrowserWindowsProtocolHostBase extends BrowserWindowsProtocolEnvelopeBase {
  requestId: BrowserWindowsRequestId;
  invokeId: BrowserWindowsParticipantId;
  route: string;
}

export interface BrowserWindowsHostRequestMessage extends BrowserWindowsProtocolHostBase {
  type: "host_request";
  operation: Extract<ScompTransportOperation, "request">;
  payload: unknown;
}

export interface BrowserWindowsHostSignalMessage extends BrowserWindowsProtocolHostBase {
  type: "host_signal";
  operation: Extract<ScompTransportOperation, "signal">;
  payload: unknown;
}
export interface BrowserWindowsHostFeedStartMessage extends BrowserWindowsProtocolHostBase {
  type: "host_feed_start";
  operation: Extract<ScompTransportOperation, "feed">;
  payload: unknown;
  payloadKey: BrowserWindowsPayloadKey;
  payloadHash: BrowserWindowsCanonicalPayloadHash;
}

export interface BrowserWindowsHostFeedStopMessage extends BrowserWindowsProtocolHostBase {
  type: "host_feed_stop";
  operation: Extract<ScompTransportOperation, "signal">;
  method: "__scomp.unsubscribe";
  payloadKey: BrowserWindowsPayloadKey;
  payloadHash: BrowserWindowsCanonicalPayloadHash;
}
export interface BrowserWindowsHostResponseMessage extends BrowserWindowsProtocolEnvelopeBase {
  type: "host_response";
  requestId: BrowserWindowsRequestId;
  invokeId: BrowserWindowsParticipantId;
  hostId: BrowserWindowsParticipantId;
  payload?: unknown;
  error?: string;
}

export interface BrowserWindowsHostFeedStartedMessage extends BrowserWindowsProtocolEnvelopeBase {
  type: "host_feed_started";
  requestId: BrowserWindowsRequestId;
  invokeId: BrowserWindowsParticipantId;
  hostId: BrowserWindowsParticipantId;
  payloadKey: BrowserWindowsPayloadKey;
  payloadHash: BrowserWindowsCanonicalPayloadHash;
}

export interface BrowserWindowsHostFeedChunkMessage extends BrowserWindowsProtocolEnvelopeBase {
  type: "host_feed_chunk";
  requestId: BrowserWindowsRequestId;
  invokeId: BrowserWindowsParticipantId;
  hostId: BrowserWindowsParticipantId;
  payloadKey: BrowserWindowsPayloadKey;
  payloadHash: BrowserWindowsCanonicalPayloadHash;
  chunkType: ScompFeedChunkType;
  payload?: unknown;
  message?: string;
}

export interface BrowserWindowsInvokeResponseMessage extends BrowserWindowsProtocolEnvelopeBase {
  type: "invoke_response";
  requestId: BrowserWindowsRequestId;
  hostId: BrowserWindowsParticipantId;
  payload?: unknown;
  error?: string;
}

export interface BrowserWindowsInvokeFeedChunkMessage extends BrowserWindowsProtocolEnvelopeBase {
  type: "invoke_feed_chunk";
  requestId: BrowserWindowsRequestId;
  hostId: BrowserWindowsParticipantId;
  payloadKey: BrowserWindowsPayloadKey;
  payloadHash: BrowserWindowsCanonicalPayloadHash;
  chunkType: ScompFeedChunkType;
  payload?: unknown;
  message?: string;
}

export type BrowserWindowsProtocolMessage =
  | BrowserWindowsHelloMessage
  | BrowserWindowsHelloAckMessage
  | BrowserWindowsParticipantDisconnectMessage
  | BrowserWindowsHeartbeatMessage
  | BrowserWindowsRoutesRegisterMessage
  | BrowserWindowsRoutesUnregisterMessage
  | BrowserWindowsInvokeRequestMessage
  | BrowserWindowsInvokeSignalMessage
  | BrowserWindowsInvokeFeedStartMessage
  | BrowserWindowsInvokeFeedStopMessage
  | BrowserWindowsHostRequestMessage
  | BrowserWindowsHostSignalMessage
  | BrowserWindowsHostFeedStartMessage
  | BrowserWindowsHostFeedStopMessage
  | BrowserWindowsHostResponseMessage
  | BrowserWindowsHostFeedStartedMessage
  | BrowserWindowsHostFeedChunkMessage
  | BrowserWindowsInvokeResponseMessage
  | BrowserWindowsInvokeFeedChunkMessage;
