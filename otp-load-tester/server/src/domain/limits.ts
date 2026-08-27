/**
 * Safety limits.
 *
 * `HARD_CAPS` are compiled into the application and can never be raised by
 * configuration - they are the last line of defence against a runaway test.
 * The operator-configurable limits are clamped to them at startup.
 */

export interface SafetyLimits {
  maxMessagesPerMinute: number;
  maxMessagesPerTest: number;
  maxDurationSeconds: number;
  maxConcurrentTests: number;
}

export const HARD_CAPS: SafetyLimits = Object.freeze({
  maxMessagesPerMinute: 600,
  maxMessagesPerTest: 5_000,
  maxDurationSeconds: 3_600,
  maxConcurrentTests: 10,
});

export const DEFAULT_LIMITS: SafetyLimits = Object.freeze({
  maxMessagesPerMinute: 60,
  maxMessagesPerTest: 500,
  maxDurationSeconds: 900,
  maxConcurrentTests: 3,
});

export const OTP_LENGTH_RANGE = Object.freeze({ min: 4, max: 8, default: 6 });

/** A test is force-stopped this long after its configured duration expires. */
export const WATCHDOG_GRACE_MS = 5_000;

export function clampLimits(requested: Partial<SafetyLimits>): SafetyLimits {
  const merged = { ...DEFAULT_LIMITS, ...stripUndefined(requested) };
  return {
    maxMessagesPerMinute: clamp(merged.maxMessagesPerMinute, 1, HARD_CAPS.maxMessagesPerMinute),
    maxMessagesPerTest: clamp(merged.maxMessagesPerTest, 1, HARD_CAPS.maxMessagesPerTest),
    maxDurationSeconds: clamp(merged.maxDurationSeconds, 1, HARD_CAPS.maxDurationSeconds),
    maxConcurrentTests: clamp(merged.maxConcurrentTests, 1, HARD_CAPS.maxConcurrentTests),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function stripUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v)),
  ) as Partial<T>;
}
