import type { AnyServiceDefinition, FireAndForgetErrorHandler } from "./types";
import { invokeServiceMethod } from "./service-invoker";

function reportFireAndForgetError(
  error: unknown,
  methodName: string,
  args: ReadonlyArray<unknown>,
  onError?: FireAndForgetErrorHandler,
): void {
  if (onError) {
    onError(error, methodName, args);
    return;
  }

  queueMicrotask(() => {
    throw error;
  });
}

export function executeFireAndForget(
  service: AnyServiceDefinition,
  methodName: string,
  args: ReadonlyArray<unknown>,
  onError?: FireAndForgetErrorHandler,
): void {
  try {
    const result = invokeServiceMethod(service, methodName, args);

    void Promise.resolve(result).catch((error) => {
      reportFireAndForgetError(error, methodName, args, onError);
    });
  } catch (error) {
    if (onError) {
      onError(error, methodName, args);
      return;
    }

    throw error;
  }
}
