import type { ScompServiceDefinition } from '@scomp/core';

export type AnyServiceDefinition = ScompServiceDefinition<
  Record<string, (...args: Array<any>) => any>,
  Record<string, (...args: Array<any>) => any>,
  Record<string, (...args: Array<any>) => any>
>;

export type FireAndForgetErrorHandler = (
  error: unknown,
  methodName: string,
  args: ReadonlyArray<unknown>
) => void;

export interface InprocessTransportOptions {
  onFireAndForgetError?: FireAndForgetErrorHandler;
}
