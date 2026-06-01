import type { ScompClientInvokeOptions } from "@scompr/types";

export type { ScompClientInvokeOptions } from "@scompr/types";

export interface ITransport {
  registerRoutes(router: Record<string, unknown>): Promise<void> | void;
  close(): Promise<void> | void;
  request(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<unknown>;
  signal(route: string, payload: unknown, options?: ScompClientInvokeOptions): Promise<void>;
  feed(route: string, payload: unknown, options?: ScompClientInvokeOptions): AsyncIterable<unknown>;
}
