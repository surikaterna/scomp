import { type ScompFeed } from "./feed";

type ControllerRequestHandler = (...args: Array<any>) => unknown;
type ControllerCommandHandler = (...args: Array<any>) => void | Promise<void>;

type ControllerRequestHandlers = Record<string, ControllerRequestHandler>;
type ControllerCommandHandlers = Record<string, ControllerCommandHandler>;

type ControllerMethods<
  Requests extends ControllerRequestHandlers,
  Commands extends ControllerCommandHandlers,
> = Requests & Commands;

/**
 * Method kind for controller methods.
 */
export type ScompControllerMethodKind = "request" | "command";

/**
 * Runtime definition of a feed controller's request and command methods.
 */
export interface ScompFeedControllerDefinition<
  Requests extends ControllerRequestHandlers,
  Commands extends ControllerCommandHandlers,
> {
  readonly requests: Requests;
  readonly commands: Commands;
  readonly kinds: Readonly<Record<string, ScompControllerMethodKind>>;
  invoke(methodName: string, args: ReadonlyArray<unknown>): unknown;
}

/**
 * A feed with an attached controller that exposes request and command methods.
 *
 * @typeParam ResponseType - Type emitted through the feed's data channel.
 * @typeParam ErrorType - Type emitted through the feed's error channel.
 * @typeParam Requests - Controller request handler map.
 * @typeParam Commands - Controller command handler map.
 */
export interface ScompControlledFeed<
  ResponseType = unknown,
  ErrorType = Error,
  Requests extends ControllerRequestHandlers = ControllerRequestHandlers,
  Commands extends ControllerCommandHandlers = ControllerCommandHandlers,
> extends ScompFeed<ResponseType, ErrorType> {
  readonly controller: ScompFeedControllerDefinition<Requests, Commands>;
}

type EmptyControllerMethods = Record<never, never>;

function buildControllerDefinition<
  Requests extends ControllerRequestHandlers,
  Commands extends ControllerCommandHandlers,
>(
  requests: Requests,
  commands: Commands,
): ScompFeedControllerDefinition<Requests, Commands> {
  const handlers: Record<string, (...args: Array<any>) => unknown> = {
    ...requests,
    ...commands,
  };

  const kinds: Record<string, ScompControllerMethodKind> = {};
  for (const name of Object.keys(requests)) kinds[name] = "request";
  for (const name of Object.keys(commands)) kinds[name] = "command";

  return {
    requests,
    commands,
    kinds,
    invoke(methodName: string, args: ReadonlyArray<unknown>) {
      const method = handlers[methodName];
      if (!method) {
        throw new Error(`Unknown controller method: ${methodName}`);
      }
      return method(...args);
    },
  };
}

/**
 * Fluent builder for attaching a typed controller to a feed.
 *
 * @typeParam ResponseType - Type emitted through the feed's data channel.
 * @typeParam ErrorType - Type emitted through the feed's error channel.
 * @typeParam Requests - Accumulated controller request handlers.
 * @typeParam Commands - Accumulated controller command handlers.
 */
export class ScompFeedControllerBuilder<
  ResponseType,
  ErrorType,
  Requests extends ControllerRequestHandlers,
  Commands extends ControllerCommandHandlers,
> {
  private readonly _feed: ScompFeed<ResponseType, ErrorType>;
  private readonly _requests: Requests;
  private readonly _commands: Commands;

  constructor(
    feed: ScompFeed<ResponseType, ErrorType>,
    requests: Requests,
    commands: Commands,
  ) {
    this._feed = feed;
    this._requests = requests;
    this._commands = commands;
  }

  private copy<
    NextRequests extends ControllerRequestHandlers,
    NextCommands extends ControllerCommandHandlers,
  >(requests: NextRequests, commands: NextCommands) {
    return new ScompFeedControllerBuilder<
      ResponseType,
      ErrorType,
      NextRequests,
      NextCommands
    >(this._feed, requests, commands);
  }

  /**
   * Adds a request/response method to the controller.
   */
  request<MethodName extends string, Handler extends ControllerRequestHandler>(
    methodName: MethodName extends keyof ControllerMethods<Requests, Commands>
      ? never
      : MethodName,
    handler: Handler,
  ) {
    return this.copy(
      {
        ...this._requests,
        [methodName]: handler,
      } as Requests & Record<MethodName, Handler>,
      this._commands,
    );
  }

  /**
   * Adds a fire-and-forget command method to the controller.
   */
  command<MethodName extends string, Handler extends ControllerCommandHandler>(
    methodName: MethodName extends keyof ControllerMethods<Requests, Commands>
      ? never
      : MethodName,
    handler: Handler,
  ) {
    return this.copy(this._requests, {
      ...this._commands,
      [methodName]: handler,
    } as Commands & Record<MethodName, Handler>);
  }

  /**
   * Finalizes the builder and returns a controlled feed.
   */
  build(): ScompControlledFeed<ResponseType, ErrorType, Requests, Commands> {
    const controllerDef = buildControllerDefinition(
      this._requests,
      this._commands,
    );
    return Object.assign(this._feed, {
      controller: controllerDef,
    }) as ScompControlledFeed<ResponseType, ErrorType, Requests, Commands>;
  }
}

/**
 * Creates a controller builder for the given feed.
 *
 * @example
 * ```ts
 * const feed = createScompFeed<number>();
 * const controlled = createControlledFeed(feed)
 *   .request('getInterval', () => currentInterval)
 *   .command('setInterval', (ms: number) => { currentInterval = ms; })
 *   .build();
 * ```
 */
export function createControlledFeed<ResponseType = unknown, ErrorType = Error>(
  feed: ScompFeed<ResponseType, ErrorType>,
): ScompFeedControllerBuilder<
  ResponseType,
  ErrorType,
  EmptyControllerMethods,
  EmptyControllerMethods
> {
  return new ScompFeedControllerBuilder(
    feed,
    {} as EmptyControllerMethods,
    {} as EmptyControllerMethods,
  );
}
