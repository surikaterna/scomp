import type { ScompClientInvokeOptions } from "@scompr/types";

export type { ScompClientInvokeOptions } from "@scompr/types";

export interface ITransport {
  registerRoutes(router: Record<string, unknown>): Promise<void> | void;
  close(): Promise<void> | void;
  request(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<unknown>;
  signal(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<void>;
  feed(route: string, payload: unknown, options?: ScompClientInvokeOptions): AsyncIterable<unknown>;
  /**
   * Unified invocation method. When implemented, the client proxy uses this
   * instead of separate request/signal/feed methods.
   *
   * Returns:
   * - For requests: Promise resolves to the response value
   * - For signals: Promise resolves to undefined (NOP ack)
   * - For feeds: Promise resolves to an AsyncIterable of chunks
   */
  invoke?(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<unknown>;
}
