/**
 * Core domain vocabulary. This module is intentionally free of any framework,
 * transport or persistence concern so the business rules can be unit tested in
 * isolation.
 */

/** Lifecycle of a test session. */
export const TEST_STATUSES = [
  'CREATED',
  'RUNNING',
  'PAUSED',
  'STOPPING',
  'STOPPED',
  'COMPLETED',
  'FAILED',
] as const;

export type TestStatus = (typeof TEST_STATUSES)[number];

/** Statuses from which no transition back into execution is possible. */
export const TERMINAL_STATUSES: readonly TestStatus[] = ['STOPPED', 'COMPLETED', 'FAILED'];

export function isTerminal(status: TestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Why a run finished, used to pick the final status and for the audit trail. */
export type StopReason =
  | 'USER_STOP'
  | 'MAX_MESSAGES_REACHED'
  | 'DURATION_ELAPSED'
  | 'WATCHDOG_TIMEOUT'
  | 'SERVER_SHUTDOWN'
  | 'FATAL_ERROR';

export type SmsMode = 'mock' | 'sandbox' | 'authorized';

export interface TestConfig {
  recipient: string;
  otpLength: number;
  messagesPerMinute: number;
  maxMessages: number;
  durationSeconds: number;
  testName: string | null;
  /** Explicit operator acknowledgement that the recipient may be tested. */
  authorizationAcknowledged: true;
}

export interface TestSession extends TestConfig {
  id: string;
  status: TestStatus;
  smsMode: SmsMode;
  generated: number;
  sent: number;
  failed: number;
  createdBy: string;
  stopReason: StopReason | null;
  createdAt: string;
  startedAt: string | null;
  pausedAt: string | null;
  stoppedAt: string | null;
  completedAt: string | null;
}

export type AttemptStatus = 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';

export interface OtpAttempt {
  id: string;
  testId: string;
  sequence: number;
  recipient: string;
  /** HMAC-SHA256 of the OTP. Always present. */
  otpHash: string;
  /** Plaintext OTP - only ever populated in local mock mode. */
  otpPlaintext: string | null;
  status: AttemptStatus;
  providerMessageId: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  testId: string;
  at: string;
  level: LogLevel;
  event: string;
  message: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  testId: string | null;
  detail: string | null;
  ip: string | null;
}

/** Aggregated live view pushed to the dashboard. */
export interface TestSnapshot {
  testId: string;
  testName: string | null;
  status: TestStatus;
  recipient: string;
  smsMode: SmsMode;
  otpLength: number;
  generated: number;
  sent: number;
  failed: number;
  configuredRatePerMinute: number;
  observedRatePerMinute: number;
  maxMessages: number;
  remainingMessages: number;
  durationSeconds: number;
  startedAt: string | null;
  stoppedAt: string | null;
  completedAt: string | null;
  elapsedMs: number;
  remainingMs: number;
  stopReason: StopReason | null;
}
