import type { ScompClientInvokeOptions } from "@scomp/core";
import type { ScompTransportOperation } from "@scomp/types";
import type { BrowserWindowsTransportSecurity } from "./transport-browser-windows-security";
import { reportAuthDeniedError } from "./transport-browser-windows-health-events";
import type {
  BrowserWindowsTransportHealthReasonCode,
  BrowserWindowsTransportHealthStatus,
} from "./types";

type HealthReporter = (
  code: BrowserWindowsTransportHealthReasonCode,
  detail: string | undefined,
  status: BrowserWindowsTransportHealthStatus,
) => void;

export async function composeMetaWithHealth(
  security: BrowserWindowsTransportSecurity,
  route: string,
  operation: ScompTransportOperation,
  payload: unknown,
  options: ScompClientInvokeOptions | undefined,
  reportHealth: HealthReporter,
) {
  try {
    return await security.composeMetaForOperation(route, operation, payload, options);
  } catch (error) {
    reportAuthDeniedError(reportHealth, error);
    throw error;
  }
}
