import type { ScompClientInvokeOptions } from "@scompr/core";
import { mergeMeta, toPriorityMeta } from "@scompr/transport-shared";
import type { ScompTransportMessageMeta } from "@scompr/types";

export async function composeOutboundMeta(
  configMeta:
    | ScompTransportMessageMeta
    | (() => ScompTransportMessageMeta | Promise<ScompTransportMessageMeta>)
    | undefined,
  options?: ScompClientInvokeOptions,
): Promise<ScompTransportMessageMeta | undefined> {
  let baseMeta: ScompTransportMessageMeta | undefined;
  if (typeof configMeta === "function") {
    baseMeta = await configMeta();
  } else {
    baseMeta = configMeta;
  }
  const priorityMeta = toPriorityMeta(options);
  return mergeMeta(mergeMeta(baseMeta, options?.meta), priorityMeta);
}
