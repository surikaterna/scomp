import type { ITransport, ScompClientInvokeOptions } from "@scomp/core";

export class BrowserWindowsTransport implements ITransport {
  private router?: Record<string, unknown>;

  listen(router: Record<string, unknown>): void {
    this.router = router;
  }

  close(): void {
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

export function createBrowserWindowsTransport(): BrowserWindowsTransport {
  return new BrowserWindowsTransport();
}
