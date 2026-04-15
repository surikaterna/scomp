export { createContractToken, type ContractToken } from "./contract-token";

export {
  createFeedHash,
  createRuntimeNeutralFeedHasher,
  type FeedHashOptions,
  type ScompFeedHashFunction,
} from "./feed-hash";

export {
  SCOMP_FRAMEWORK_PREFIX,
  ScompFrameworkMethods,
  type ScompFrameworkMethod,
} from "./framework-methods";

export {
  SCOMP_SCOPE,
  createControlledFeed,
  type ControlledAsyncIterable,
  type ControlledFeedOptions,
} from "./controlled-feed";

export {
  ScompFeed,
  createScompFeed,
  fromAsyncIterable,
  fromGenerator,
  fromLegacyObservable,
  type LegacyObservableLike,
  type ScompFeedLike,
} from "./feed";

export {
  composeScompFragments,
  createScompFragment,
  createScompService,
  type CompiledRoute,
  type CompiledRouter,
  type DiagnoseContract,
  type DiagnoseMethod,
  type FragmentDefinition,
  type FragmentMethodImplementations,
  type FeedImplementationConfig,
  type GroupedFragmentMethodImplementations,
  type GroupedServiceMethodImplementations,
  type IsValidContract,
  type RequestImplementationConfig,
  type ServiceDefinition,
  type SignalImplementationConfig,
  type ValidContract,
} from "./builder";

export {
  createNodeLocalDiscoverHandler,
  createNodeLocalHealthHandler,
  createNodeLocalResolveHandler,
  composeRouterWithControlPlaneRoutes,
  createControlPlaneRouter,
  getControlPlaneRouteSecurityAdvice,
  type ControlPlaneRouteSecurityAdvice,
  type NodeLocalHealthCheckResult,
  type NodeLocalHealthHandlerContext,
  type NodeLocalHealthHandlerOptions,
  SCOMP_CONTROL_PLANE_ROUTE_NAMES,
  type NodeLocalDiscoverHandlerOptions,
  type NodeLocalResolveHandlerOptions,
  type ScompControlPlaneRouteHandlers,
} from "./control-plane";

export {
  ScompControlPlane,
  type ScompControlPlaneContract,
} from "./control-plane-contract";

export { type ITransport, type ScompClientInvokeOptions } from "./transport";

export {
  createScompPeer,
  type ClientFactory,
  type CreateScompPeerConfig,
  type IScompPeer,
} from "./peer";

export {
  SCOMP_DEFAULT_OPERATION_PRIORITIES,
  normalizeScompPriority,
  resolveScompPriority,
  type ScompPriorityBounds,
  type ScompPriorityClass,
  type ScompPriorityDecision,
  type ScompPriorityPolicy,
  type ScompPriorityResolutionContext,
  type ScompPrioritySource,
  type ScompPriorityValue,
} from "./priority";

export {
  // Legacy API retained for in-process transport compatibility.
  createScompClient,
  createScompService as createLegacyScompService,
  ScompServiceBuilder,
  type ScompClientForService,
  type ScompServiceDefinition,
  type ScompServiceDescriptor,
  type ScompServiceMethodKind,
  type ScompTransport,
} from "./service";
