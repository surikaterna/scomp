import type { ScompTransport } from "@scompr/core";
import { executeFireAndForget } from "./fire-and-forget";
import { toFeedResponse, toRequestResponse } from "./result-adapters";
import { invokeServiceMethod } from "./service-invoker";
import type { AnyServiceDefinition, InprocessTransportOptions } from "./types";

export function createInprocessTransport(
  service: AnyServiceDefinition,
  options: InprocessTransportOptions = {},
): ScompTransport {
  return {
    async request<ResponseType>(methodName: string, args: ReadonlyArray<unknown>) {
      const result = invokeServiceMethod(service, methodName, args);
      return toRequestResponse<ResponseType>(result, methodName);
    },

    observe<ResponseType = unknown, ErrorType = Error>(methodName: string, args: ReadonlyArray<unknown>) {
      const result = invokeServiceMethod(service, methodName, args);
      return toFeedResponse<ResponseType, ErrorType>(result, methodName);
    },

    fireAndForget(methodName: string, args: ReadonlyArray<unknown>) {
      executeFireAndForget(service, methodName, args, options.onFireAndForgetError);
    },
  };
}
