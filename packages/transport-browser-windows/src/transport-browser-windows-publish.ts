import type {
  BrowserWindowsTransportHealthReasonCode,
  BrowserWindowsTransportHealthStatus,
} from "./types";

type HealthReporter = (
  code: BrowserWindowsTransportHealthReasonCode,
  detail: string | undefined,
  status: BrowserWindowsTransportHealthStatus,
) => void;

export function publishMessageWithHealth(
  postMessage: (message: unknown) => void,
  reportHealth: HealthReporter,
  message: unknown,
): void {
  try {
    postMessage(message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    reportHealth("publish-failed", detail, "unavailable");
  }
}
