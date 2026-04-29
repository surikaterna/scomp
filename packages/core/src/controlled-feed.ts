/**
 * Cross-realm safe symbol used to tag the feed scoping mode on a
 * {@link ControlledAsyncIterable}.  Prefer this over a plain string
 * property so the key never collides with user-defined properties.
 */
export const SCOMP_SCOPE = Symbol.for("scomp.scope");

export interface ControlledFeedOptions {
  /**
   * Feed scoping mode.
   * - `'exclusive'`: Each subscriber gets its own controller instance (default).
   * - `'fanout'`: Subscribers share a single controller instance.
   */
  scope?: "exclusive" | "fanout";
}

/**
 * An async iterable that also exposes a typed controller for
 * client-to-server messages scoped to an active feed subscription.
 */
export interface ControlledAsyncIterable<T, C = unknown> extends AsyncIterable<T> {
  readonly controller: C;
  /** @internal Feed scoping mode for the runtime. */
  readonly [SCOMP_SCOPE]?: "exclusive" | "fanout";
}

/**
 * Creates a controlled feed by combining an async iterable with controller methods.
 *
 * @param iterable - The server-push async iterable
 * @param controllerMethods - Object whose methods are callable by the client on this feed
 * @param options - Optional feed configuration
 * @throws If any controller method name starts with '__scomp.' (reserved prefix)
 */
export function createControlledFeed<T, C extends object>(
  iterable: AsyncIterable<T>,
  controllerMethods: C,
  options?: ControlledFeedOptions,
): ControlledAsyncIterable<T, C> {
  for (const key of Object.keys(controllerMethods)) {
    if (key.startsWith("__scomp.")) {
      throw new Error(`Controller method "${key}" uses reserved __scomp. prefix.`);
    }
  }

  return {
    [Symbol.asyncIterator]() {
      return iterable[Symbol.asyncIterator]();
    },
    controller: controllerMethods,
    [SCOMP_SCOPE]: options?.scope ?? "exclusive",
  };
}
