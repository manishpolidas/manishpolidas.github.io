import { loadConfig, type AppConfig } from '../config.js';
import { buildContainer, type BuildOptions, type Container } from '../container.js';
import type { SmsMode } from '../domain/types.js';
import { CancelledError, delay } from '../services/time.js';
import {
  SmsProviderError,
  type SendOtpContext,
  type SendOtpResult,
  type SmsProvider,
} from '../infrastructure/sms/SmsProvider.js';

export const TEST_USER = { username: 'tester', password: 'password123' };

/** Config built from an explicit env map - never from the ambient process env. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-0123456789',
    OTP_HASH_PEPPER: 'test-pepper',
    DASHBOARD_USERNAME: TEST_USER.username,
    DASHBOARD_PASSWORD: TEST_USER.password,
    SMS_MODE: 'mock',
    MOCK_LATENCY_MS: '0',
    MOCK_LATENCY_JITTER_MS: '0',
    MOCK_FAILURE_RATE: '0',
    MAX_MESSAGES_PER_MINUTE: '600',
    MAX_MESSAGES_PER_TEST: '500',
    MAX_DURATION_SECONDS: '600',
    MAX_CONCURRENT_TESTS: '3',
    API_RATE_LIMIT_PER_MINUTE: '10000',
    PERSISTENCE: 'memory',
    ...overrides,
  });
}

export function testContainer(
  configOverrides: Record<string, string> = {},
  options: BuildOptions = {},
): Container {
  return buildContainer(testConfig(configOverrides), {
    consoleLogging: false,
    ...options,
  });
}

export interface RecordedSend {
  recipient: string;
  otp: string;
  sequence: number;
  at: number;
}

/**
 * Deterministic provider for scheduler tests: configurable latency, forced
 * failures, and a record of every send plus every cancellation.
 */
export class FakeSmsProvider implements SmsProvider {
  readonly name = 'fake-sms-provider';
  readonly mode: SmsMode = 'mock';

  readonly sends: RecordedSend[] = [];
  cancelled = 0;
  disposed = false;

  private counter = 0;

  constructor(
    private readonly options: {
      latencyMs?: number;
      failEvery?: number;
      failAll?: boolean;
    } = {},
  ) {}

  get sendCount(): number {
    return this.sends.length;
  }

  async sendOtp(recipient: string, otp: string, context: SendOtpContext): Promise<SendOtpResult> {
    this.counter += 1;
    const sequence = context.sequence;
    this.sends.push({ recipient, otp, sequence, at: Date.now() });

    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) {
      try {
        await delay(latency, context.signal);
      } catch (error) {
        if (error instanceof CancelledError) this.cancelled += 1;
        throw error;
      }
    } else if (context.signal?.aborted) {
      this.cancelled += 1;
      throw new CancelledError();
    }

    const shouldFail =
      this.options.failAll === true ||
      (this.options.failEvery !== undefined && this.counter % this.options.failEvery === 0);
    if (shouldFail) throw new SmsProviderError(`forced failure #${this.counter}`);

    return {
      messageId: `FAKE-${this.counter}`,
      recipient,
      status: 'SENT',
      timestamp: new Date().toISOString(),
      latencyMs: latency,
    };
  }

  dispose(): void {
    this.disposed = true;
  }
}

export function baseTestPayload(overrides: Record<string, unknown> = {}) {
  return {
    recipient: 'TEST-USER-001',
    otpLength: 6,
    messagesPerMinute: 600,
    maxMessages: 5,
    durationSeconds: 60,
    testName: 'unit test',
    authorizationAcknowledged: true,
    ...overrides,
  };
}

export const adminActor = { username: TEST_USER.username, role: 'admin' as const, ip: '127.0.0.1' };
export const viewerActor = { username: 'reader', role: 'viewer' as const, ip: '127.0.0.1' };

/** Polls `predicate` until it holds or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5_000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await delay(intervalMs);
  }
}
