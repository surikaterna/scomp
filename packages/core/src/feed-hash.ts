export interface FeedHashOptions {
  hashKey?: (payload: unknown) => string;
  stringify?: (value: unknown) => string;
  hash?: ScompFeedHashFunction;
}

export type ScompFeedHashFunction = (value: string) => string;

export function createRuntimeNeutralFeedHasher(): ScompFeedHashFunction {
  return (value: string): string => {
    const normalized = String(value);
    const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae3d];

    const chunks = seeds.map((seed) => {
      let hash = seed >>> 0;
      for (let index = 0; index < normalized.length; index += 1) {
        hash ^= normalized.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }

      return hash.toString(16).padStart(8, "0");
    });

    return chunks.join("").slice(0, 32);
  };
}

const defaultFeedHasher = createRuntimeNeutralFeedHasher();

function normalizeHash(hash: string): string {
  const normalized = hash.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Feed hash function returned an empty hash value.");
  }

  if (normalized.length >= 32) {
    return normalized.slice(0, 32);
  }

  return normalized.padEnd(32, "0");
}

export function createFeedHash(route: string, payload: unknown, options: FeedHashOptions = {}): string {
  if (options.hashKey) {
    return options.hashKey(payload);
  }

  const stringify = options.stringify ?? JSON.stringify;
  const serialized = stringify(payload ?? {});
  const hash = (options.hash ?? defaultFeedHasher)(`${route}:${serialized}`);
  return normalizeHash(hash);
}
