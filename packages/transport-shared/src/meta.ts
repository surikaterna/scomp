import type { ScompClientInvokeOptions } from "@scomp/core";
import type {
  ScompTransportMessageMeta,
  ScompTransportPrincipal,
} from "@scomp/types";

export function toPriorityMeta(
  options?: ScompClientInvokeOptions,
): ScompTransportMessageMeta | undefined {
  if (!options) {
    return undefined;
  }

  const { priority, priorityClass, deadlineAtMs, targetLatencyMs } = options;
  if (
    priority === undefined &&
    priorityClass === undefined &&
    deadlineAtMs === undefined &&
    targetLatencyMs === undefined
  ) {
    return undefined;
  }

  const meta: ScompTransportMessageMeta = {};
  if (priority !== undefined) {
    meta.priority = priority;
  }
  if (priorityClass !== undefined) {
    meta.priorityClass = priorityClass;
  }
  if (deadlineAtMs !== undefined) {
    meta.deadlineAtMs = deadlineAtMs;
  }
  if (targetLatencyMs !== undefined) {
    meta.targetLatencyMs = targetLatencyMs;
  }

  return meta;
}

export function toPrincipalMeta(
  principal: ScompTransportPrincipal | undefined,
): ScompTransportMessageMeta | undefined {
  if (!principal) {
    return undefined;
  }

  return {
    auth: {
      subject: principal.subject,
      tenantId: principal.tenantId,
      scopes: principal.scopes,
      claims: principal.claims,
      issuedAt: principal.issuedAt,
      expiresAt: principal.expiresAt,
      authType: principal.authType,
    },
    tenantId: principal.tenantId,
  };
}

export function mergeMeta(
  baseMeta: ScompTransportMessageMeta | undefined,
  overlayMeta: ScompTransportMessageMeta | undefined,
): ScompTransportMessageMeta | undefined {
  if (!baseMeta && !overlayMeta) {
    return undefined;
  }

  return {
    ...(baseMeta ?? {}),
    ...(overlayMeta ?? {}),
  };
}
