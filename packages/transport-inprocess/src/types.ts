import type { ScompServiceDefinition } from "@scompr/core";

export type AnyServiceDefinition = ScompServiceDefinition<
  Record<string, (...args: Array<unknown>) => Promise<unknown>>,
  Record<string, (...args: Array<unknown>) => AsyncIterable<unknown> | Iterable<unknown>>,
  Record<string, (...args: Array<unknown>) => void | Promise<void>>
>;

export type FireAndForgetErrorHandler = (error: unknown, methodName: string, args: ReadonlyArray<unknown>) => void;

export interface InprocessTransportOptions {
  onFireAndForgetError?: FireAndForgetErrorHandler;
}
