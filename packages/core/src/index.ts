export {
  ScompFeed,
  createScompFeed,
  fromAsyncIterable,
  fromGenerator,
  fromLegacyObservable,
  type LegacyObservableLike,
  type ScompFeedLike
} from './feed'

export {
  createScompService,
  type CompiledRoute,
  type CompiledRouter,
  type FeedImplementationConfig,
  type RequestImplementationConfig,
  type ServiceDefinition,
  type SignalImplementationConfig
} from './builder'

export {
  type ITransport
} from './transport'

export {
  // Legacy API retained for in-process transport compatibility.
  createScompClient,
  createScompService as createLegacyScompService,
  ScompServiceBuilder,
  type ScompClientForService,
  type ScompServiceDefinition,
  type ScompServiceDescriptor,
  type ScompServiceMethodKind,
  type ScompTransport
} from './service'
