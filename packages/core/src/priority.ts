import type {
  ScompPriorityClass as TransportPriorityClass,
  ScompPriorityHint,
  ScompTransportMessageMeta,
  ScompTransportOperation,
} from "@scomp/types";

export type ScompPriorityClass = TransportPriorityClass;

const PRIORITY_INDEX_TO_CLASS = ["P0", "P1", "P2", "P3", "P4"] as const;

type PriorityIndex = 0 | 1 | 2 | 3 | 4;

const PRIORITY_CLASS_TO_INDEX: Record<ScompPriorityClass, PriorityIndex> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

export type ScompPriorityValue = ScompPriorityHint;

export interface ScompPriorityResolutionContext {
  route: string;
  operation: ScompTransportOperation;
  meta?: (ScompTransportMessageMeta & Record<string, unknown>) | undefined;
  requestedPriority?: unknown;
}

export type ScompPriorityRouteOverride =
  | ScompPriorityValue
  | ((context: ScompPriorityResolutionContext) => ScompPriorityValue);

export interface ScompPriorityBounds {
  highest?: ScompPriorityValue;
  lowest?: ScompPriorityValue;
}

export interface ScompPriorityPolicy {
  routeOverrides?: Partial<Record<string, ScompPriorityRouteOverride>>;
  operationDefaults?: Partial<Record<ScompTransportOperation, ScompPriorityValue>>;
  defaultPriority?: ScompPriorityValue;
  allowMetadataHint?: boolean;
  metadataHintSelector?: (context: ScompPriorityResolutionContext) => unknown;
  bounds?: ScompPriorityBounds;
}

export type ScompPrioritySource = "route_override" | "metadata_hint" | "operation_default" | "fallback_default";

export interface ScompPriorityDecision {
  route: string;
  operation: ScompTransportOperation;
  source: ScompPrioritySource;
  requested: ScompPriorityClass | undefined;
  effective: ScompPriorityClass;
}

export const SCOMP_DEFAULT_OPERATION_PRIORITIES: Readonly<Record<ScompTransportOperation, ScompPriorityClass>> =
  Object.freeze({
    request: "P2",
    signal: "P3",
    feed: "P1",
  });

function valueToPriorityIndex(value: unknown): PriorityIndex | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value >= 0 && value <= 4) {
      return value as PriorityIndex;
    }
    return undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }

  const priorityMatch = /^P?([0-4])$/.exec(normalized);
  if (!priorityMatch) {
    return undefined;
  }

  return Number(priorityMatch[1]) as PriorityIndex;
}

function priorityClassFromIndex(index: PriorityIndex): ScompPriorityClass {
  return PRIORITY_INDEX_TO_CLASS[index];
}

function readDefaultMetadataHint(context: ScompPriorityResolutionContext): unknown {
  if (context.requestedPriority !== undefined) {
    return context.requestedPriority;
  }

  const metaRecord = context.meta as Record<string, unknown> | undefined;
  if (!metaRecord) {
    return undefined;
  }

  if ("priority" in metaRecord) {
    return metaRecord.priority;
  }

  if ("priorityClass" in metaRecord) {
    return metaRecord.priorityClass;
  }

  const tags = metaRecord.tags;
  if (!tags || typeof tags !== "object") {
    return undefined;
  }

  return (tags as Record<string, unknown>).priority;
}

function resolveRouteOverride(
  context: ScompPriorityResolutionContext,
  policy?: ScompPriorityPolicy,
): ScompPriorityClass | undefined {
  const override = policy?.routeOverrides?.[context.route];
  if (!override) {
    return undefined;
  }

  const rawValue = typeof override === "function" ? override(context) : override;
  return normalizeScompPriority(rawValue);
}

function resolveOperationDefault(
  context: ScompPriorityResolutionContext,
  policy?: ScompPriorityPolicy,
): ScompPriorityClass | undefined {
  const explicit = policy?.operationDefaults?.[context.operation];
  const normalizedExplicit = normalizeScompPriority(explicit);
  if (normalizedExplicit) {
    return normalizedExplicit;
  }

  const operationDefault =
    SCOMP_DEFAULT_OPERATION_PRIORITIES[context.operation as keyof typeof SCOMP_DEFAULT_OPERATION_PRIORITIES];
  return normalizeScompPriority(operationDefault);
}

function getBounds(policy?: ScompPriorityPolicy): {
  highest: PriorityIndex;
  lowest: PriorityIndex;
} {
  const highest = valueToPriorityIndex(policy?.bounds?.highest) ?? 0;
  const lowest = valueToPriorityIndex(policy?.bounds?.lowest) ?? 4;

  if (highest > lowest) {
    return {
      highest: 0,
      lowest: 4,
    };
  }

  return {
    highest,
    lowest,
  };
}

function clampToBounds(priority: ScompPriorityClass, policy?: ScompPriorityPolicy): ScompPriorityClass {
  const bounds = getBounds(policy);
  const rawIndex = PRIORITY_CLASS_TO_INDEX[priority];

  if (rawIndex < bounds.highest) {
    return priorityClassFromIndex(bounds.highest);
  }

  if (rawIndex > bounds.lowest) {
    return priorityClassFromIndex(bounds.lowest);
  }

  return priority;
}

function resolveRequestedPriority(
  context: ScompPriorityResolutionContext,
  policy?: ScompPriorityPolicy,
): ScompPriorityClass | undefined {
  if (policy?.allowMetadataHint === false) {
    return undefined;
  }

  const raw = policy?.metadataHintSelector ? policy.metadataHintSelector(context) : readDefaultMetadataHint(context);
  return normalizeScompPriority(raw);
}

export function normalizeScompPriority(value: unknown): ScompPriorityClass | undefined {
  const index = valueToPriorityIndex(value);
  if (index === undefined) {
    return undefined;
  }

  return priorityClassFromIndex(index);
}

export function resolveScompPriority(
  context: ScompPriorityResolutionContext,
  policy?: ScompPriorityPolicy,
): ScompPriorityDecision {
  const fallbackDefault = normalizeScompPriority(policy?.defaultPriority) ?? "P2";
  const routeOverride = resolveRouteOverride(context, policy);
  const requested = resolveRequestedPriority(context, policy);
  const operationDefault = resolveOperationDefault(context, policy);

  let source: ScompPrioritySource = "fallback_default";
  let effective = fallbackDefault;

  if (routeOverride) {
    source = "route_override";
    effective = routeOverride;
  } else if (requested) {
    source = "metadata_hint";
    effective = requested;
  } else if (operationDefault) {
    source = "operation_default";
    effective = operationDefault;
  }

  return {
    route: context.route,
    operation: context.operation,
    source,
    requested,
    effective: clampToBounds(effective, policy),
  };
}
