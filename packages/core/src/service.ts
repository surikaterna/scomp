import { type ScompFeed } from './feed';

type RequestHandler = (...args: Array<unknown>) => unknown;
type FeedHandler = (...args: Array<unknown>) => ScompFeed<unknown, unknown> | AsyncIterable<unknown> | Iterable<unknown>;
type CommandHandler = (...args: Array<unknown>) => void | Promise<void>;

type RequestHandlers = Record<string, RequestHandler>;
type FeedHandlers = Record<string, FeedHandler>;
type CommandHandlers = Record<string, CommandHandler>;

type ServiceMethods<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers
> = Requests & Feeds & Commands;

/**
 * Runtime method category used by service definitions.
 */
export type ScompServiceMethodKind = 'request' | 'feed' | 'command';

/**
 * Canonical, executable shape of a scomp service.
 */
export interface ScompServiceDefinition<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers
> {
  /** Request/response handlers that return one value. */
  readonly requests: Requests;
  /** Feed handlers that return streams. */
  readonly feeds: Feeds;
  /** Fire-and-forget handlers. */
  readonly commands: Commands;
  /** Method kind lookup by method name. */
  readonly kinds: Readonly<Record<string, ScompServiceMethodKind>>;
  /** Invokes a service method with positional arguments. */
  invoke(methodName: string, args: ReadonlyArray<unknown>): unknown;
}

/**
 * Descriptor accepted by {@link createScompService}.
 */
export interface ScompServiceDescriptor<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers
> {
  requests?: Requests;
  feeds?: Feeds;
  commands?: Commands;
}

/**
 * Client/server transport abstraction.
 *
 * @deprecated Use {@link ITransport} instead. This legacy interface will be removed in a future release.
 */
export interface ScompTransport {
  /** Performs a unary request/response call. */
  request<ResponseType = unknown>(methodName: string, args: ReadonlyArray<unknown>): Promise<ResponseType>;
  /** Starts observing values from a feed method. */
  observe<ResponseType = unknown, ErrorType = Error>(
    methodName: string,
    args: ReadonlyArray<unknown>
  ): ScompFeed<ResponseType, ErrorType>;
  /** Invokes a command method with no response contract. */
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

/**
 * Type-safe client API inferred from a service definition.
 */
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

/**
 * Fluent builder for creating type-safe service definitions.
 *
 * @deprecated Use {@link createScompService} with contract tokens instead. This class will be removed in a future release.
 */
export class ScompServiceBuilder<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers
> {
  private readonly _requests: Requests;
  private readonly _feeds: Feeds;
  private readonly _commands: Commands;

  /**
   * Creates a builder with existing handler maps.
   */
  constructor(requests: Requests, feeds: Feeds, commands: Commands) {
    this._requests = requests;
    this._feeds = feeds;
    this._commands = commands;
  }

  /**
   * Adds a request/response method.
   */
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

  /**
   * Adds a feed method.
   */
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

  /**
   * Adds a fire-and-forget command method.
   */
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

  /**
   * Finalizes and returns an executable service definition.
   */
  build() {
    return buildServiceDefinition(this._requests, this._feeds, this._commands);
  }
}

/**
 * Creates an empty fluent service builder.
 */
export function createScompService(): ScompServiceBuilder<EmptyMethods, EmptyMethods, EmptyMethods>;
/**
 * Creates a service definition from plain handler maps.
 */
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

/**
 * Creates a transport-backed client from a service definition.
 *
 * @deprecated Use {@link createScompPeer} instead. This function will be removed in a future release.
 */
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