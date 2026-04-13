import { type ScompFeed } from "./feed";

type RequestHandler = (...args: Array<unknown>) => unknown;
type FeedHandler = (
  ...args: Array<unknown>
) => ScompFeed<unknown, unknown> | AsyncIterable<unknown> | Iterable<unknown>;
type CommandHandler = (...args: Array<unknown>) => void | Promise<void>;

type RequestHandlers = Record<string, RequestHandler>;
type FeedHandlers = Record<string, FeedHandler>;
type CommandHandlers = Record<string, CommandHandler>;

type ServiceMethods<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers,
> = Requests & Feeds & Commands;

/**
 * Runtime method category used by service definitions.
 */
export type ScompServiceMethodKind = "request" | "feed" | "command";

/**
 * Canonical, executable shape of a scomp service.
 */
export interface ScompServiceDefinition<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers,
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
  Commands extends CommandHandlers,
> {
  requests?: Requests;
  feeds?: Feeds;
  commands?: Commands;
}

/**
 * Client/server transport abstraction.
 */
export interface ScompTransport {
  /** Performs a unary request/response call. */
  request<ResponseType = unknown>(
    methodName: string,
    args: ReadonlyArray<unknown>,
  ): Promise<ResponseType>;
  /** Starts observing values from a feed method. */
  observe<ResponseType = unknown, ErrorType = Error>(
    methodName: string,
    args: ReadonlyArray<unknown>,
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
  [MethodName in keyof Feeds]: (
    ...args: Parameters<Feeds[MethodName]>
  ) => FeedResponse<Feeds[MethodName]>;
};

type ClientCommandMethods<Commands extends CommandHandlers> = {
  [MethodName in keyof Commands]: (
    ...args: Parameters<Commands[MethodName]>
  ) => void;
};

/**
 * Type-safe client API inferred from a service definition.
 */
export type ScompClientForService<
  Service extends ScompServiceDefinition<
    RequestHandlers,
    FeedHandlers,
    CommandHandlers
  >,
> = ClientRequestMethods<Service["requests"]> &
  ClientFeedMethods<Service["feeds"]> &
  ClientCommandMethods<Service["commands"]>;

type EmptyMethods = Record<never, never>;

type ServiceHandler = (...params: Array<unknown>) => unknown;
type ServiceHandlerMap = Record<string, ServiceHandler>;

function stringKeys<T extends Record<string, unknown>>(
  value: T,
): Array<Extract<keyof T, string>> {
  return Object.keys(value) as Array<Extract<keyof T, string>>;
}

function mergeHandlers(
  requests: RequestHandlers,
  feeds: FeedHandlers,
  commands: CommandHandlers,
): ServiceHandlerMap {
  return { ...requests, ...feeds, ...commands };
}

function assignMethodKind(
  kinds: Record<string, ScompServiceMethodKind>,
  handlers: Record<string, unknown>,
  kind: ScompServiceMethodKind,
) {
  for (const methodName of Object.keys(handlers)) {
    kinds[methodName] = kind;
  }
}

function buildMethodKinds(
  requests: RequestHandlers,
  feeds: FeedHandlers,
  commands: CommandHandlers,
): Readonly<Record<string, ScompServiceMethodKind>> {
  const kinds: Record<string, ScompServiceMethodKind> = {};
  assignMethodKind(kinds, requests, "request");
  assignMethodKind(kinds, feeds, "feed");
  assignMethodKind(kinds, commands, "command");
  return kinds;
}

function ensureUniqueMethodNames(
  requests: RequestHandlers,
  feeds: FeedHandlers,
  commands: CommandHandlers,
) {
  const claimedBy = new Map<string, ScompServiceMethodKind>();

  const register = (
    kind: ScompServiceMethodKind,
    handlers: Record<string, unknown>,
  ) => {
    for (const methodName of Object.keys(handlers)) {
      const existingKind = claimedBy.get(methodName);
      if (existingKind) {
        throw new Error(
          `Service method "${methodName}" is defined as both ${existingKind} and ${kind}. ` +
            "Each method name must be unique across requests, feeds, and commands.",
        );
      }
      claimedBy.set(methodName, kind);
    }
  };

  register("request", requests);
  register("feed", feeds);
  register("command", commands);
}

function createServiceInvoker(handlers: ServiceHandlerMap) {
  return (methodName: string, args: ReadonlyArray<unknown>): unknown => {
    const method = handlers[methodName];
    if (!method) {
      throw new Error(`Unknown service method: ${methodName}`);
    }
    return method(...args);
  };
}

function buildServiceDefinition<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers,
>(
  requests: Requests,
  feeds: Feeds,
  commands: Commands,
): ScompServiceDefinition<Requests, Feeds, Commands> {
  ensureUniqueMethodNames(requests, feeds, commands);
  const handlers = mergeHandlers(requests, feeds, commands);
  const invoke = createServiceInvoker(handlers);

  return {
    requests,
    feeds,
    commands,
    kinds: buildMethodKinds(requests, feeds, commands),
    invoke,
  };
}

/**
 * Fluent builder for creating type-safe service definitions.
 */
export class ScompServiceBuilder<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers,
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

  private copy<
    NextRequests extends RequestHandlers,
    NextFeeds extends FeedHandlers,
    NextCommands extends CommandHandlers,
  >(requests: NextRequests, feeds: NextFeeds, commands: NextCommands) {
    return new ScompServiceBuilder<NextRequests, NextFeeds, NextCommands>(
      requests,
      feeds,
      commands,
    );
  }

  /**
   * Adds a request/response method.
   */
  request<MethodName extends string, Handler extends RequestHandler>(
    methodName: MethodName extends keyof ServiceMethods<
      Requests,
      Feeds,
      Commands
    >
      ? never
      : MethodName,
    handler: Handler,
  ) {
    return this.copy(
      {
        ...this._requests,
        [methodName]: handler,
      } as Requests & Record<MethodName, Handler>,
      this._feeds,
      this._commands,
    );
  }

  /**
   * Adds a feed method.
   */
  feed<MethodName extends string, Handler extends FeedHandler>(
    methodName: MethodName extends keyof ServiceMethods<
      Requests,
      Feeds,
      Commands
    >
      ? never
      : MethodName,
    handler: Handler,
  ) {
    return this.copy(
      this._requests,
      {
        ...this._feeds,
        [methodName]: handler,
      } as Feeds & Record<MethodName, Handler>,
      this._commands,
    );
  }

  /**
   * Adds a fire-and-forget command method.
   */
  command<MethodName extends string, Handler extends CommandHandler>(
    methodName: MethodName extends keyof ServiceMethods<
      Requests,
      Feeds,
      Commands
    >
      ? never
      : MethodName,
    handler: Handler,
  ) {
    return this.copy(this._requests, this._feeds, {
      ...this._commands,
      [methodName]: handler,
    } as Commands & Record<MethodName, Handler>);
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
export function createScompService(): ScompServiceBuilder<
  EmptyMethods,
  EmptyMethods,
  EmptyMethods
> {
  return new ScompServiceBuilder<EmptyMethods, EmptyMethods, EmptyMethods>(
    {},
    {},
    {},
  );
}

/**
 * Creates a service definition from plain handler maps.
 */
export function createScompServiceFromDescriptor<
  Requests extends RequestHandlers,
  Feeds extends FeedHandlers,
  Commands extends CommandHandlers,
>(
  descriptor: ScompServiceDescriptor<Requests, Feeds, Commands>,
): ScompServiceDefinition<Requests, Feeds, Commands> {
  const requests = (descriptor.requests || {}) as Requests;
  const feeds = (descriptor.feeds || {}) as Feeds;
  const commands = (descriptor.commands || {}) as Commands;
  return buildServiceDefinition(requests, feeds, commands);
}

/**
 * Creates a transport-backed client from a service definition.
 */
export function createScompClient<
  Service extends ScompServiceDefinition<
    RequestHandlers,
    FeedHandlers,
    CommandHandlers
  >,
>(service: Service, transport: ScompTransport): ScompClientForService<Service> {
  const client: Record<string, unknown> = {};

  for (const methodName of stringKeys(service.requests)) {
    client[methodName] = (...args: Array<unknown>) =>
      transport.request(methodName, args);
  }

  for (const methodName of stringKeys(service.feeds)) {
    client[methodName] = (...args: Array<unknown>) =>
      transport.observe(methodName, args);
  }

  for (const methodName of stringKeys(service.commands)) {
    client[methodName] = (...args: Array<unknown>) => {
      transport.fireAndForget(methodName, args);
    };
  }

  return client as ScompClientForService<Service>;
}
