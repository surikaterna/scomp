export function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error(fallback);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.iterator in value &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === "function"
  );
}

export function toAsyncIterable(value: unknown): AsyncIterable<unknown> {
  if (isAsyncIterable(value)) {
    return value;
  }

  if (isIterable(value)) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const nextValue of value) {
          yield nextValue;
        }
      },
    };
  }

  throw new Error("Feed handler did not return an iterable value.");
}
