import type {
  ScompFeedChunkEnvelope,
  ScompTransportRequestEnvelope,
  ScompTransportResponseEnvelope,
} from "@scompr/types";

export type TransportMessage = ScompTransportRequestEnvelope | ScompTransportResponseEnvelope | ScompFeedChunkEnvelope;

export function isFeedChunkEnvelope(message: TransportMessage): message is ScompFeedChunkEnvelope {
  return (message as ScompFeedChunkEnvelope).channel === "feed";
}
