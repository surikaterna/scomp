import type { ScompClientInvokeOptions } from "@scompr/types";

export type { ScompClientInvokeOptions } from "@scompr/types";

export interface ITransport {
  registerRoutes(router: Record<string, unknown>): Promise<void> | void;
  close(): Promise<void> | void;
  /**
   * Unified invocation method. The transport determines behavior based on
   * the route's registered kind:
   * - request: Promise resolves to the response value
   * - signal: Promise resolves to undefined (NOP ack, confirms delivery)
   * - feed: Promise resolves to an AsyncIterable of chunks
   */
  invoke(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<unknown>;
}
