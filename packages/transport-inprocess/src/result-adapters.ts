import { fromAsyncIterable, type ScompFeed } from "@scomp/core";
import { isIterableLike, isScompFeed } from "./type-guards";

export function toRequestResponse<ResultType>(result: unknown, methodName: string): Promise<ResultType> {
  if (isScompFeed(result) || isIterableLike(result)) {
    throw new Error(`Method ${methodName} is configured as a feed and cannot be used as request/response.`);
  }

  return Promise.resolve(result as ResultType);
}

export function toFeedResponse<ResponseType, ErrorType = Error>(
  result: unknown,
  methodName: string,
): ScompFeed<ResponseType, ErrorType> {
  if (isScompFeed(result)) {
    return result as ScompFeed<ResponseType, ErrorType>;
  }

  if (isIterableLike(result)) {
    return fromAsyncIterable(result) as ScompFeed<ResponseType, ErrorType>;
  }

  throw new Error(`Method ${methodName} did not return a feed-compatible value.`);
}
