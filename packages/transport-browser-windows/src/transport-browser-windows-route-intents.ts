import type { ScompTransportOperation } from "@scomp/types";
import type {
  BrowserWindowsRouteIntent,
  BrowserWindowsRouteIntentKind,
  BrowserWindowsRouteIntentMap,
} from "./types";

type BrowserWindowsCompiledRouteLike = {
  kind?: BrowserWindowsRouteIntentKind;
};

function resolveIntentKind(kind: BrowserWindowsRouteIntentKind | undefined): BrowserWindowsRouteIntentKind {
  return kind ?? "request";
}

function operationToIntentKind(operation: ScompTransportOperation): BrowserWindowsRouteIntentKind {
  if (operation === "signal") {
    return "signal";
  }

  if (operation === "feed_start" || operation === "feed_stop") {
    return "feed";
  }

  return "request";
}

function toIntentMap(
  intents: BrowserWindowsRouteIntentMap | ReadonlyArray<BrowserWindowsRouteIntent>,
): BrowserWindowsRouteIntentMap {
  if (Array.isArray(intents)) {
    const resolved: Record<string, BrowserWindowsRouteIntentKind> = {};
    for (const intent of intents) {
      resolved[intent.route] = intent.kind;
    }
    return resolved;
  }

  return intents;
}

export function createRouteIntentsFromCompiledRouter(
  router: Readonly<Record<string, BrowserWindowsCompiledRouteLike>>,
): BrowserWindowsRouteIntentMap {
  const intents: Record<string, BrowserWindowsRouteIntentKind> = {};

  for (const [route, definition] of Object.entries(router)) {
    intents[route] = resolveIntentKind(definition.kind);
  }

  return intents;
}

export function createRouteIntentsFromCompiledRouters(
  routers: ReadonlyArray<Readonly<Record<string, BrowserWindowsCompiledRouteLike>>>,
): BrowserWindowsRouteIntentMap {
  const intents: Record<string, BrowserWindowsRouteIntentKind> = {};

  for (const router of routers) {
    for (const [route, definition] of Object.entries(router)) {
      intents[route] = resolveIntentKind(definition.kind);
    }
  }

  return intents;
}

export function assertStrictRouteIntentAllowed(
  strictEnabled: boolean,
  configuredIntents: BrowserWindowsRouteIntentMap | ReadonlyArray<BrowserWindowsRouteIntent> | undefined,
  route: string,
  operation: ScompTransportOperation,
): void {
  if (!strictEnabled) {
    return;
  }

  const intentMap = configuredIntents ? toIntentMap(configuredIntents) : undefined;
  if (!intentMap) {
    throw new Error(
      "BrowserWindowsTransport strictRouteIntents is enabled, but no routeIntents were configured.",
    );
  }

  const configuredKind = intentMap[route];
  if (!configuredKind) {
    throw new Error(
      `BrowserWindowsTransport strict route-intent rejection: unknown route \"${route}\" for operation \"${operation}\".`,
    );
  }

  const attemptedKind = operationToIntentKind(operation);
  if (configuredKind !== attemptedKind) {
    throw new Error(
      `BrowserWindowsTransport strict route-intent rejection: route \"${route}\" allows \"${configuredKind}\" but attempted \"${operation}\".`,
    );
  }
}
