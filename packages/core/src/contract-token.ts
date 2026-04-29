/**
 * Binds a TypeScript contract type to a service name at runtime.
 * The phantom `__contract` field carries the type but is never read at runtime.
 */
export interface ContractToken<C extends object> {
  readonly name: string;
  /** @internal Phantom field — carries the contract type. Never read at runtime. */
  readonly __contract: C;
}

/**
 * Creates a contract token that binds a contract type to a service name.
 */
export function createContractToken<C extends object>(name: string): ContractToken<C> {
  if (!name || typeof name !== "string") {
    throw new Error("Contract token name must be a non-empty string.");
  }
  return {
    name,
    __contract: undefined as unknown as C,
  };
}
