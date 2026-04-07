import type { ITransport, ScompClientInvokeOptions } from "@scomp/core";
import type { BrowserWindowsTransportConfig } from "./types";

export class BrowserWindowsTransport implements ITransport {
  private readonly config: BrowserWindowsTransportConfig;
  private router?: Record<string, unknown>;

  constructor(config: BrowserWindowsTransportConfig = {}) {
    this.config = config;
  }

  listen(router: Record<string, unknown>): void {
    this.router = router;
  }

  close(): void {
    void this.config;
    // no-op scaffold behavior for now
  }

  async request(
    _route: string,
    _payload: unknown,
    _options?: ScompClientInvokeOptions,
  ): Promise<unknown> {
    throw new Error("BrowserWindowsTransport.request() not implemented");
  }

  async signal(
    _route: string,
    _payload: unknown,
    _options?: ScompClientInvokeOptions,
  ): Promise<void> {
    throw new Error("BrowserWindowsTransport.signal() not implemented");
  }

  feed(
    _route: string,
    _payload: unknown,
    _options?: ScompClientInvokeOptions,
  ): AsyncIterable<unknown> {
    throw new Error("BrowserWindowsTransport.feed() not implemented");
  }
}

export function createBrowserWindowsTransport(
  config: BrowserWindowsTransportConfig = {},
): BrowserWindowsTransport {
  return new BrowserWindowsTransport(config);
}
