import { type ScompFeed } from './feed';

type RequestHandler = (...args: Array<any>) => any;
type FeedHandler = (...args: Array<any>) => ScompFeed<any, any> | AsyncIterable<any> | Iterable<any>;
type CommandHandler = (...args: Array<any>) => void | Promise<void>;

type RequestHandlers = Record<string, RequestHandler>;
type FeedHandlers = Record<string, FeedHandler>;
type CommandHandlers = Record<string, CommandHandler>;

type ServiceMethods<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers
> = Requests & Feeds & Commands;

export type ScompServiceMethodKind = 'request' | 'feed' | 'command';

export interface ScompServiceDefinition<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers
> {
  readonly requests: Requests;
  readonly feeds: Feeds;
  readonly commands: Commands;
  readonly kinds: Readonly<Record<string, ScompServiceMethodKind>>;
  invoke(methodName: string, args: ReadonlyArray<unknown>): unknown;
}

export interface ScompServiceDescriptor<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers
> {
  requests?: Requests;
  feeds?: Feeds;
  commands?: Commands;
}

export interface ScompTransport {
  request<ResponseType = unknown>(methodName: string, args: ReadonlyArray<unknown>): Promise<ResponseType>;
  observe<ResponseType = unknown, ErrorType = Error>(
    methodName: string,
    args: ReadonlyArray<unknown>
  ): ScompFeed<ResponseType, ErrorType>;
  fireAndForget(methodName: string, args: ReadonlyArray<unknown>): void;
}

type ClientRequestMethods<Requests extends RequestHandlers> = {
  [MethodName in keyof Requests]: (
    ...args: Parameters<Requests[MethodName]>
  ) => Promise<Awaited<ReturnType<Requests[MethodName]>>>;
};

type FeedResponse<Handler extends FeedHandler> =
  ReturnType<Handler> extends ScompFeed<infer ResponseType, infer ErrorType>
    ? ScompFeed<ResponseType, ErrorType>
    : ReturnType<Handler> extends AsyncIterable<infer ResponseType>
      ? ScompFeed<ResponseType, unknown>
      : ReturnType<Handler> extends Iterable<infer ResponseType>
        ? ScompFeed<ResponseType, unknown>
        : ScompFeed<unknown, unknown>;

type ClientFeedMethods<Feeds extends FeedHandlers> = {
  [MethodName in keyof Feeds]: (...args: Parameters<Feeds[MethodName]>) => FeedResponse<Feeds[MethodName]>;
};

type ClientCommandMethods<Commands extends CommandHandlers> = {
  [MethodName in keyof Commands]: (...args: Parameters<Commands[MethodName]>) => void;
};

export type ScompClientForService<
  Service extends ScompServiceDefinition<RequestHandlers, FeedHandlers, CommandHandlers>
> = ClientRequestMethods<Service['requests']>
  & ClientFeedMethods<Service['feeds']>
  & ClientCommandMethods<Service['commands']>;

type EmptyMethods = Record<never, never>;

function buildServiceDefinition<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers
>(
  requests: Requests,
  feeds: Feeds,
  commands: Commands
): ScompServiceDefinition<Requests, Feeds, Commands> {
  const handlers: ServiceMethods<Requests, Feeds, Commands> = {
    ...requests,
    ...feeds,
    ...commands
  };

  const kinds: Record<string, ScompServiceMethodKind> = {};

  for (const methodName of Object.keys(requests)) {
    kinds[methodName] = 'request';
  }
  for (const methodName of Object.keys(feeds)) {
    kinds[methodName] = 'feed';
  }
  for (const methodName of Object.keys(commands)) {
    kinds[methodName] = 'command';
  }

  return {
    requests,
    feeds,
    commands,
    kinds,
    invoke(methodName: string, args: ReadonlyArray<unknown>) {
      const method = (handlers as Record<string, (...params: Array<unknown>) => unknown>)[methodName];
      if (!method) {
        throw new Error(`Unknown service method: ${methodName}`);
      }
      return method(...args);
    }
  };
}

export class ScompServiceBuilder<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers
> {
  private readonly _requests: Requests;
  private readonly _feeds: Feeds;
  private readonly _commands: Commands;

  constructor(requests: Requests, feeds: Feeds, commands: Commands) {
    this._requests = requests;
    this._feeds = feeds;
    this._commands = commands;
  }

  request<
    MethodName extends string,
    Handler extends RequestHandler
  >(
    methodName: MethodName extends keyof ServiceMethods<Requests, Feeds, Commands> ? never : MethodName,
    handler: Handler
  ) {
    return new ScompServiceBuilder<Requests & Record<MethodName, Handler>, Feeds, Commands>(
      {
        ...this._requests,
        [methodName]: handler
      } as Requests & Record<MethodName, Handler>,
      this._feeds,
      this._commands
    );
  }

  feed<
    MethodName extends string,
    Handler extends FeedHandler
  >(
    methodName: MethodName extends keyof ServiceMethods<Requests, Feeds, Commands> ? never : MethodName,
    handler: Handler
  ) {
    return new ScompServiceBuilder<Requests, Feeds & Record<MethodName, Handler>, Commands>(
      this._requests,
      {
        ...this._feeds,
        [methodName]: handler
      } as Feeds & Record<MethodName, Handler>,
      this._commands
    );
  }

  command<
    MethodName extends string,
    Handler extends CommandHandler
  >(
    methodName: MethodName extends keyof ServiceMethods<Requests, Feeds, Commands> ? never : MethodName,
    handler: Handler
  ) {
    return new ScompServiceBuilder<Requests, Feeds, Commands & Record<MethodName, Handler>>(
      this._requests,
      this._feeds,
      {
        ...this._commands,
        [methodName]: handler
      } as Commands & Record<MethodName, Handler>
    );
  }

  build() {
    return buildServiceDefinition(this._requests, this._feeds, this._commands);
  }
}

export function createScompService(): ScompServiceBuilder<EmptyMethods, EmptyMethods, EmptyMethods>;
export function createScompService<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers
>(
  descriptor: ScompServiceDescriptor<Requests, Feeds, Commands>
): ScompServiceDefinition<Requests, Feeds, Commands>;
export function createScompService<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers
>(
  descriptor?: ScompServiceDescriptor<Requests, Feeds, Commands>
) {
  if (!descriptor) {
    return new ScompServiceBuilder<EmptyMethods, EmptyMethods, EmptyMethods>({}, {}, {});
  }

  const requests = (descriptor.requests || {}) as Requests;
  const feeds = (descriptor.feeds || {}) as Feeds;
  const commands = (descriptor.commands || {}) as Commands;
  return buildServiceDefinition(requests, feeds, commands);
}

export function createScompClient<
  Service extends ScompServiceDefinition<RequestHandlers, FeedHandlers, CommandHandlers>
>(
  service: Service,
  transport: ScompTransport
): ScompClientForService<Service> {
  const client: Record<string, unknown> = {};

  for (const methodName of Object.keys(service.requests)) {
    client[methodName] = (...args: Array<unknown>) => transport.request(methodName, args);
  }

  for (const methodName of Object.keys(service.feeds)) {
    client[methodName] = (...args: Array<unknown>) => transport.observe(methodName, args);
  }

  for (const methodName of Object.keys(service.commands)) {
    client[methodName] = (...args: Array<unknown>) => {
      transport.fireAndForget(methodName, args);
    };
  }

  return client as ScompClientForService<Service>;
}