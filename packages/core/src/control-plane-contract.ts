import type {
  ScompControlPlaneDiscoverRequest,
  ScompControlPlaneDiscoverResponse,
  ScompControlPlaneResolveRequest,
  ScompControlPlaneResolveResponse,
  ScompControlPlaneHealthRequest,
  ScompControlPlaneHealthResponse,
} from "@scomp/types";
import { createContractToken, type ContractToken } from "./contract-token";

/**
 * Contract type for the scomp control plane.
 * Method signatures match the existing node-local handler factories
 * so the contract can be implemented directly with their return values.
 */
export interface ScompControlPlaneContract {
  discover(input: ScompControlPlaneDiscoverRequest): Promise<ScompControlPlaneDiscoverResponse>;
  resolve(input: ScompControlPlaneResolveRequest): Promise<ScompControlPlaneResolveResponse>;
  health(input: ScompControlPlaneHealthRequest): Promise<ScompControlPlaneHealthResponse>;
}

/**
 * Singleton contract token for the scomp control plane.
 * Uses the reserved `__scomp` namespace to match control-plane route conventions.
 */
export const ScompControlPlane: ContractToken<ScompControlPlaneContract> =
  createContractToken<ScompControlPlaneContract>("__scomp");
