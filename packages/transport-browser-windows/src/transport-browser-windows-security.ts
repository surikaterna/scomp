import type { ScompClientInvokeOptions } from "@scomp/core";
import type {
  ScompTransportMessageMeta,
  ScompTransportOperation,
  ScompTransportPrincipal,
  ScompTransportSecurityContext,
} from "@scomp/types";
import { mergeMeta, toPrincipalMeta, toPriorityMeta } from "./shared-worker-internal";
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
    const effectiveMeta = mergeMeta(mergeMeta(configMeta, optionsMeta), priorityMeta);
    const { allowed, principal } = await this.checkSecurity({
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
    const { allowed } = await this.checkSecurity({
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

  private async checkSecurity(
    ctx: Omit<ScompTransportSecurityContext, "principal">,
  ): Promise<{ allowed: boolean; principal?: ScompTransportPrincipal }> {
    const policy = this.config.security;
    if (!policy) {
      return { allowed: true };
    }

    const principal = policy.authenticate ? await policy.authenticate(ctx) : undefined;

    if (!policy.authorize) {
      return { allowed: true, principal: principal ?? undefined };
    }

    const allowed = Boolean(
      await policy.authorize({
        ...ctx,
        principal: principal ?? undefined,
      }),
    );

    return { allowed, principal: principal ?? undefined };
  }
}
