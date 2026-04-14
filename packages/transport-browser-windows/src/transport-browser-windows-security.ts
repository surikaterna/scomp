import type { ScompClientInvokeOptions } from "@scomp/core";
import type {
  ScompTransportMessageMeta,
  ScompTransportOperation,
  ScompTransportPrincipal,
} from "@scomp/types";
import {
  checkSecurity,
  mergeMeta,
  toPrincipalMeta,
  toPriorityMeta,
} from "@scomp/transport-shared";
import type { BrowserWindowsTransportConfig } from "./types";

export class BrowserWindowsTransportSecurity {
  constructor(private readonly config: BrowserWindowsTransportConfig) {}

  async resolveConfigMeta(): Promise<ScompTransportMessageMeta | undefined> {
    const { meta } = this.config;
    if (!meta) {
      return undefined;
    }

    if (typeof meta === "function") {
      return meta();
    }

    return meta;
  }

  /**
   * Deterministic outbound meta precedence (websocket-browser parity):
   * config.meta -> options.meta -> priority hints -> principal-derived auth context.
   */
  async composeMetaForOperation(
    route: string,
    operation: ScompTransportOperation,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<{
    meta: ScompTransportMessageMeta | undefined;
    principal: ScompTransportPrincipal | undefined;
  }> {
    const configMeta = await this.resolveConfigMeta();
    const optionsMeta = options?.meta;
    const priorityMeta = toPriorityMeta(options);
    const effectiveMeta = mergeMeta(
      mergeMeta(configMeta, optionsMeta),
      priorityMeta,
    );
    const { allowed, principal } = await checkSecurity(this.config.security, {
      direction: "outbound",
      transport: "browser-windows",
      route,
      operation,
      payload,
      meta: effectiveMeta,
    });

    if (!allowed) {
      throw new Error(`${operation} not authorized for route: ${route}`);
    }

    return {
      meta: mergeMeta(effectiveMeta, toPrincipalMeta(principal)),
      principal,
    };
  }

  async assertInboundAllowed(
    route: string,
    operation: ScompTransportOperation,
    payload: unknown,
    meta: ScompTransportMessageMeta | undefined,
  ): Promise<void> {
    const { allowed } = await checkSecurity(this.config.security, {
      direction: "inbound",
      transport: "browser-windows",
      route,
      operation,
      payload,
      meta,
    });

    if (!allowed) {
      throw new Error(`${operation} not authorized for route: ${route}`);
    }
  }
}
