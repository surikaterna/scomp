import type { BrowserWindowsRuntimeEvent } from "./shared-worker-connector";
import type { BrowserWindowsTransportHealthReasonCode, BrowserWindowsTransportHealthStatus } from "./types";

type HealthReporter = (
  code: BrowserWindowsTransportHealthReasonCode,
  detail: string | undefined,
  status: BrowserWindowsTransportHealthStatus,
) => void;

export function reportAuthDeniedError(reportHealth: HealthReporter, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/not authorized/i.test(message)) {
    reportHealth("auth-denied", message, "degraded");
  }
}

export function reportRuntimeHealthEvent(reportHealth: HealthReporter, event: BrowserWindowsRuntimeEvent): void {
  if (event.type === "active-mode-changed") {
    return;
  }

  if (event.type === "broadcast-channel-unavailable") {
    reportHealth("broadcast-channel-unavailable", event.detail, "unavailable");
    return;
  }

  if (event.type === "shared-worker-unavailable") {
    reportHealth("shared-worker-unavailable", event.detail, "degraded");
    return;
  }

  if (event.type === "leader-failover") {
    reportHealth(
      "leader-failover",
      `Leader changed from ${event.previousLeaderId} to ${event.nextLeaderId}`,
      "degraded",
    );
  }
}

export function reportUnavailableConnectorError(reportHealth: HealthReporter, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/shared-worker-unavailable:/i.test(message)) {
    reportHealth("shared-worker-unavailable", message, "unavailable");
    return;
  }

  if (/broadcast-channel-unavailable:/i.test(message)) {
    reportHealth("broadcast-channel-unavailable", message, "unavailable");
  }
}
