export interface ITransport {
  listen(router: any): Promise<void> | void;
  request(route: string, payload: any): Promise<any>;
  signal(route: string, payload: any): Promise<void>;
  feed(route: string, payload: any): AsyncIterable<any>;
}
