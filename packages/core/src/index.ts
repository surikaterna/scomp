export const createCore = () => ({
  status: 'ok'
})

export {
  createScompFeed,
  fromAsyncIterable,
  fromGenerator,
  fromLegacyObservable,
  ScompFeedSubject,
  type LegacyObservableLike,
  type ScompFeed
} from './feed'

export {
  createScompClient,
  createScompService,
  ScompServiceBuilder,
  type ScompClientForService,
  type ScompServiceDefinition,
  type ScompServiceDescriptor,
  type ScompServiceMethodKind,
  type ScompTransport
} from './service'
