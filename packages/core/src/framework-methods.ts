/** Framework-reserved controller method prefix. */
export const SCOMP_FRAMEWORK_PREFIX = "__scomp.";

/** Framework controller methods. */
export const ScompFrameworkMethods = {
  /** Tear down a feed subscription. Op: signal. */
  UNSUBSCRIBE: "__scomp.unsubscribe",
  /** Pause feed emission (reserved for future use). Op: signal. */
  PAUSE: "__scomp.pause",
  /** Resume feed emission (reserved for future use). Op: signal. */
  RESUME: "__scomp.resume",
  /** Query feed subscription stats (reserved for future use). Op: request. */
  STATS: "__scomp.stats",
} as const;

export type ScompFrameworkMethod =
  (typeof ScompFrameworkMethods)[keyof typeof ScompFrameworkMethods];
