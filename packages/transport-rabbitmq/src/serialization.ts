import type { ScompSerializer } from '@scomp/types';

export const defaultJsonSerializer: ScompSerializer = {
  stringify(value: unknown): string {
    return JSON.stringify(value);
  },
  parse<T = unknown>(text: string): T {
    return JSON.parse(text) as T;
  },
  contentType: 'application/json'
};

export interface ExtendedJsonSerializerOptions {
  replacer?: (this: unknown, key: string, value: unknown) => unknown;
  reviver?: (this: unknown, key: string, value: unknown) => unknown;
  contentType?: string;
}

export function createJsonSerializer(options: ExtendedJsonSerializerOptions = {}): ScompSerializer {
  return {
    stringify(value: unknown): string {
      return JSON.stringify(value, options.replacer);
    },
    parse<T = unknown>(text: string): T {
      return JSON.parse(text, options.reviver) as T;
    },
    contentType: options.contentType ?? 'application/json'
  };
}
