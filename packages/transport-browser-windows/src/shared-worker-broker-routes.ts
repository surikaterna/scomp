import type { BrowserWindowsParticipantId } from "./types";
import { cloneSet, type BrokerContext } from "./shared-worker-broker-context";

export function registerRoutes(
  context: BrokerContext,
  participantId: BrowserWindowsParticipantId,
  routes: Array<string>,
): void {
  const participantRoutes = context.routesByParticipant.get(participantId) ?? new Set<string>();
  context.routesByParticipant.set(participantId, participantRoutes);

  for (const route of routes) {
    participantRoutes.add(route);
    const hosts = context.state.routeHosts.get(route) ?? new Set();
    hosts.add(participantId);
    context.state.routeHosts.set(route, hosts);
  }
}

export function unregisterRoutes(
  context: BrokerContext,
  participantId: BrowserWindowsParticipantId,
  routes: Array<string>,
): void {
  const participantRoutes = context.routesByParticipant.get(participantId);
  if (!participantRoutes) {
    return;
  }

  for (const route of routes) {
    participantRoutes.delete(route);
    const hosts = context.state.routeHosts.get(route);
    if (!hosts) {
      continue;
    }

    hosts.delete(participantId);
    if (hosts.size === 0) {
      context.state.routeHosts.delete(route);
    }
  }
}

export function unregisterAllRoutes(context: BrokerContext, participantId: BrowserWindowsParticipantId): void {
  const participantRoutes = context.routesByParticipant.get(participantId);
  if (!participantRoutes) {
    return;
  }

  context.routesByParticipant.delete(participantId);
  for (const route of participantRoutes) {
    const hosts = context.state.routeHosts.get(route);
    if (!hosts) {
      continue;
    }

    hosts.delete(participantId);
    if (hosts.size === 0) {
      context.state.routeHosts.delete(route);
    }
  }
}

export function pickHost(context: BrokerContext, route: string): BrowserWindowsParticipantId | undefined {
  const hosts = context.state.routeHosts.get(route);
  if (!hosts || hosts.size === 0) {
    return undefined;
  }

  return cloneSet(hosts)[0];
}
