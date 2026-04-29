import type { AnyServiceDefinition } from "./types";

export function invokeServiceMethod(
  service: AnyServiceDefinition,
  methodName: string,
  args: ReadonlyArray<unknown>,
): unknown {
  return service.invoke(methodName, args);
}
