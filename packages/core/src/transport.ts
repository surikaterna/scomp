export interface ITransport {
  listen(router: Record<string, unknown>): Promise<void> | void;
  request(route: string, payload: unknown): Promise<unknown>;
  signal(route: string, payload: unknown): Promise<void>;
  feed(route: string, payload: unknown): AsyncIterable<unknown>;
}
