export {
  type AuthMiddlewareConfig,
  createAuthMiddleware,
  ScompAuthError,
} from "./auth-middleware";
export {
  type CompiledRoute,
  type CompiledRouter,
  composeScompFragments,
  createScompFragment,
  createScompService,
  type DiagnoseContract,
  type DiagnoseMethod,
  type FeedImplementationConfig,
  type FragmentDefinition,
  type FragmentMethodImplementations,
  type GroupedFragmentMethodImplementations,
  type GroupedServiceMethodImplementations,
  type IsValidContract,
  type RequestImplementationConfig,
  type ServiceDefinition,
  type SignalImplementationConfig,
  type ValidContract,
} from "./builder";
export { type ContractToken, createContractToken } from "./contract-token";
export {
  type ControlPlaneRouteSecurityAdvice,
  composeRouterWithControlPlaneRoutes,
  createControlPlaneRouter,
  createNodeLocalDiscoverHandler,
  createNodeLocalHealthHandler,
  createNodeLocalResolveHandler,
  getControlPlaneRouteSecurityAdvice,
  type NodeLocalDiscoverHandlerOptions,
  type NodeLocalHealthCheckResult,
  type NodeLocalHealthHandlerContext,
  type NodeLocalHealthHandlerOptions,
  type NodeLocalResolveHandlerOptions,
  SCOMP_CONTROL_PLANE_ROUTE_NAMES,
  type ScompControlPlaneRouteHandlers,
} from "./control-plane";
export {
  ScompControlPlane,
  type ScompControlPlaneContract,
} from "./control-plane-contract";
export {
  type ControlledAsyncIterable,
  type ControlledFeedOptions,
  createControlledFeed,
  SCOMP_SCOPE,
} from "./controlled-feed";
export {
  createScompFeed,
  fromAsyncIterable,
  fromGenerator,
  fromLegacyObservable,
  type LegacyObservableLike,
  ScompFeed,
  type ScompFeedLike,
} from "./feed";
export {
  createFeedHash,
  createRuntimeNeutralFeedHasher,
  type FeedHashOptions,
  type ScompFeedHashFunction,
} from "./feed-hash";
export {
  SCOMP_FRAMEWORK_PREFIX,
  type ScompFrameworkMethod,
  ScompFrameworkMethods,
} from "./framework-methods";

export {
  getMiddlewareFns,
  runMiddlewareChain,
  type ScompHandlerContext,
  type ScompMiddleware,
  type ScompMiddlewareContext,
  type ScompMiddlewareFn,
} from "./middleware";

export { createMiddlewareTransport } from "./middleware-transport";
export {
  type ClientFactory,
  type CreateScompPeerConfig,
  createScompPeer,
  type IScompPeer,
} from "./peer";
export {
  normalizeScompPriority,
  resolveScompPriority,
  SCOMP_DEFAULT_OPERATION_PRIORITIES,
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
  createScompServiceFromDescriptor,
  type ScompClientForService,
  ScompServiceBuilder,
  type ScompServiceDefinition,
  type ScompServiceDescriptor,
  type ScompServiceMethodKind,
  type ScompTransport,
} from "./service";
export type { ITransport, ScompClientInvokeOptions } from "./transport";
