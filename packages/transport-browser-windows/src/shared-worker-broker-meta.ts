import type { ScompTransportMessageMeta } from "@scomp/types";

export const BROKER_SYSTEM_META_TAG = "scomp.broker.system";
export const BROKER_REASON_META_TAG = "scomp.broker.reason";

export type BrowserWindowsBrokerSystemMetaReason =
  | "disconnect-cleanup-feed-stop"
  | "disconnect-cleanup-feed-error"
  | "disconnect-host-response-error";

/**
 * Policy for broker-originated system notifications:
 * - Preserve invoke metadata for parity where available
 * - Add explicit structured broker system tags
 */
export function createBrokerSystemMeta(
  reason: BrowserWindowsBrokerSystemMetaReason,
): ScompTransportMessageMeta {
  return {
    tags: {
      [BROKER_SYSTEM_META_TAG]: "true",
      [BROKER_REASON_META_TAG]: reason,
    },
  };
}

export function withBrokerSystemMeta(
  meta: ScompTransportMessageMeta | undefined,
  reason: BrowserWindowsBrokerSystemMetaReason,
): ScompTransportMessageMeta {
  const systemMeta = createBrokerSystemMeta(reason);
  return {
    ...(meta ?? {}),
    tags: {
      ...(meta?.tags ?? {}),
      ...(systemMeta.tags ?? {}),
    },
  };
}
