import type { ScompFeed } from "@scomp/core";

export function isScompFeed(value: unknown): value is ScompFeed<unknown, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeFeed = value as {
    onNext?: unknown;
    onError?: unknown;
    onComplete?: unknown;
    next?: unknown;
    error?: unknown;
    complete?: unknown;
    [Symbol.asyncIterator]?: unknown;
  };

  return (
    typeof maybeFeed.onNext === "function" &&
    typeof maybeFeed.onError === "function" &&
    typeof maybeFeed.onComplete === "function" &&
    typeof maybeFeed.next === "function" &&
    typeof maybeFeed.error === "function" &&
    typeof maybeFeed.complete === "function" &&
    typeof maybeFeed[Symbol.asyncIterator] === "function"
  );
}

export function isIterableLike(value: unknown): value is AsyncIterable<unknown> | Iterable<unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeIterable = value as {
    [Symbol.iterator]?: unknown;
    [Symbol.asyncIterator]?: unknown;
  };

  return (
    typeof maybeIterable[Symbol.iterator] === "function" || typeof maybeIterable[Symbol.asyncIterator] === "function"
  );
}
