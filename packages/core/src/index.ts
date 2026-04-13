/**
 * Core package entrypoint for service and feed primitives.
 */
export const createCore = () => ({
  status: "ok",
});

export {
  createScompFeed,
  fromAsyncIterable,
  fromGenerator,
  fromLegacyObservable,
  ScompFeedSubject,
  type LegacyObservableLike,
  type ScompFeed,
} from "./feed";

export {
  createControlledFeed,
  ScompFeedControllerBuilder,
  type ScompControlledFeed,
  type ScompControllerMethodKind,
  type ScompFeedControllerDefinition,
} from "./controlled-feed";

export {
  createScompClient,
  createScompService,
  createScompServiceFromDescriptor,
  ScompServiceBuilder,
  type ScompClientForService,
  type ScompServiceDefinition,
  type ScompServiceDescriptor,
  type ScompServiceMethodKind,
  type ScompTransport,
} from "./service";
