import type { TestSession, TestSnapshot } from '../domain/types.js';

/**
 * Derives the live dashboard view from a session row.
 *
 * `elapsedMs` freezes once the test finishes so history rows stay stable.
 */
export function buildSnapshot(session: TestSession, now = Date.now()): TestSnapshot {
  const startedMs = session.startedAt ? Date.parse(session.startedAt) : null;
  const endedIso = session.stoppedAt ?? session.completedAt;
  const endedMs = endedIso ? Date.parse(endedIso) : null;
  const referenceMs = endedMs ?? now;
  const elapsedMs = startedMs === null ? 0 : Math.max(0, referenceMs - startedMs);
  const durationMs = session.durationSeconds * 1000;

  const observedRatePerMinute =
    elapsedMs > 0 ? Number(((session.generated / elapsedMs) * 60_000).toFixed(2)) : 0;

  return {
    testId: session.id,
    testName: session.testName,
    status: session.status,
    recipient: session.recipient,
    smsMode: session.smsMode,
    otpLength: session.otpLength,
    generated: session.generated,
    sent: session.sent,
    failed: session.failed,
    configuredRatePerMinute: session.messagesPerMinute,
    observedRatePerMinute,
    maxMessages: session.maxMessages,
    remainingMessages: Math.max(0, session.maxMessages - session.generated),
    durationSeconds: session.durationSeconds,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    completedAt: session.completedAt,
    elapsedMs,
    remainingMs: startedMs === null ? durationMs : Math.max(0, durationMs - elapsedMs),
    stopReason: session.stopReason,
  };
}
