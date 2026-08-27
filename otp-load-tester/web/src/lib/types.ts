/** Wire types shared with the backend API. */

export type TestStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'PAUSED'
  | 'STOPPING'
  | 'STOPPED'
  | 'COMPLETED'
  | 'FAILED';

export type SmsMode = 'mock' | 'sandbox' | 'authorized';

export interface TestSession {
  id: string;
  testName: string | null;
  recipient: string;
  status: TestStatus;
  smsMode: SmsMode;
  otpLength: number;
  messagesPerMinute: number;
  maxMessages: number;
  durationSeconds: number;
  generated: number;
  sent: number;
  failed: number;
  createdBy: string;
  stopReason: string | null;
  createdAt: string;
  startedAt: string | null;
  pausedAt: string | null;
  stoppedAt: string | null;
  completedAt: string | null;
}

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
  stopReason: string | null;
}

export interface LogEntry {
  id: string;
  testId: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  message: string;
}

export interface OtpAttempt {
  id: string;
  testId: string;
  sequence: number;
  recipient: string;
  otpHash: string;
  otpPlaintext: string | null;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
  providerMessageId: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SafetyLimits {
  maxMessagesPerMinute: number;
  maxMessagesPerTest: number;
  maxDurationSeconds: number;
  maxConcurrentTests: number;
}

export interface PlatformConfig {
  smsMode: SmsMode;
  providerName: string;
  limits: SafetyLimits;
  hardCaps: SafetyLimits;
  otpLength: { min: number; max: number; default: number };
  storePlaintextOtp: boolean;
  persistence: 'memory' | 'postgres';
  activeTests: number;
  recipientAllowlistRequired: boolean;
}

export interface Session {
  username: string;
  role: 'admin' | 'viewer';
  csrfToken: string;
}

export interface TestEnvelope {
  test: TestSession;
  snapshot: TestSnapshot;
}

export type RealtimeEvent =
  | { type: 'hello'; payload: { activeTests: number } }
  | { type: 'test.created'; payload: TestSnapshot }
  | { type: 'test.update'; payload: TestSnapshot }
  | { type: 'test.finished'; payload: TestSnapshot }
  | { type: 'test.deleted'; payload: { testId: string } }
  | { type: 'test.log'; payload: LogEntry };

export const RUNNING_STATUSES: TestStatus[] = ['RUNNING', 'PAUSED', 'STOPPING'];

export function isLive(status: TestStatus | undefined): boolean {
  return status !== undefined && RUNNING_STATUSES.includes(status);
}
