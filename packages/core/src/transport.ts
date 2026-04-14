import type {
  ScompTransportMessageMeta,
  ScompTransportPriorityHints,
} from "@scomp/types";

export interface ScompClientInvokeOptions extends ScompTransportPriorityHints {
  meta?: ScompTransportMessageMeta;
  /** Feed subscription ID for controller-scoped calls. */
  feed?: string;
  /** Controller method name for controller-scoped calls. */
  method?: string;
}

export interface ITransport {
  registerRoutes(router: Record<string, unknown>): Promise<void> | void;
  close(): Promise<void> | void;
  request(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<unknown>;
  signal(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): Promise<void>;
  feed(
    route: string,
    payload: unknown,
    options?: ScompClientInvokeOptions,
  ): AsyncIterable<unknown>;
}
