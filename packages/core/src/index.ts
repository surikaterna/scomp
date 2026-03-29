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
  createScompFragment,
  createScompService,
  type CompiledRoute,
  type CompiledRouter,
  type FragmentDefinition,
  type FragmentMethodImplementations,
  type FeedImplementationConfig,
  type GroupedFragmentMethodImplementations,
  type GroupedServiceMethodImplementations,
  type RequestImplementationConfig,
  type ServiceDefinition,
  type SignalImplementationConfig,
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

export { type ITransport, type ScompClientInvokeOptions } from "./transport";

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
