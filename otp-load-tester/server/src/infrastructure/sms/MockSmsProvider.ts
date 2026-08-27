import { randomUUID } from 'node:crypto';
import { CancelledError, delay } from '../../services/time.js';
import type { SmsMode } from '../../domain/types.js';
import {
  SmsProviderError,
  maskRecipient,
  type SendOtpContext,
  type SendOtpResult,
  type SmsProvider,
} from './SmsProvider.js';

export interface MockSmsProviderOptions {
  /** Base artificial latency in milliseconds. */
  latencyMs?: number;
  /** Uniform random jitter added to the base latency. */
  jitterMs?: number;
  /** Probability (0..1) that a send is reported as failed. */
  failureRate?: number;
  /** Injected for deterministic tests. */
  random?: () => number;
  /** Number of simulated messages retained in memory. */
  historySize?: number;
}

export interface SimulatedMessage {
  messageId: string;
  testId: string;
  sequence: number;
  recipient: string;
  /** Present so a developer can eyeball the simulator output locally. */
  otp: string;
  status: 'SENT' | 'FAILED';
  timestamp: string;
  latencyMs: number;
}

/**
 * Local SMS simulator. Performs no network I/O whatsoever, which makes it the
 * only provider that is safe by construction - and therefore the default.
 */
export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock-sms-simulator';
  readonly mode: SmsMode = 'mock';

  private readonly latencyMs: number;
  private readonly jitterMs: number;
  private readonly failureRate: number;
  private readonly random: () => number;
  private readonly historySize: number;
  private readonly history: SimulatedMessage[] = [];
  private counter = 0;

  constructor(options: MockSmsProviderOptions = {}) {
    this.latencyMs = Math.max(0, options.latencyMs ?? 120);
    this.jitterMs = Math.max(0, options.jitterMs ?? 80);
    this.failureRate = Math.min(1, Math.max(0, options.failureRate ?? 0));
    this.random = options.random ?? Math.random;
    this.historySize = options.historySize ?? 1000;
  }

  async sendOtp(recipient: string, otp: string, context: SendOtpContext): Promise<SendOtpResult> {
    const startedAt = Date.now();
    const messageId = `TEST-${(++this.counter).toString().padStart(5, '0')}-${randomUUID().slice(0, 8)}`;
    const latency = this.latencyMs + Math.floor(this.random() * this.jitterMs);

    // Abortable latency: a Stop cancels the simulated send immediately.
    try {
      await delay(latency, context.signal);
    } catch (error) {
      if (error instanceof CancelledError) {
        this.record({
          messageId,
          testId: context.testId,
          sequence: context.sequence,
          recipient,
          otp,
          status: 'FAILED',
          timestamp: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
        });
      }
      throw error;
    }

    const failed = this.random() < this.failureRate;
    const latencyMs = Date.now() - startedAt;
    this.record({
      messageId,
      testId: context.testId,
      sequence: context.sequence,
      recipient,
      otp,
      status: failed ? 'FAILED' : 'SENT',
      timestamp: new Date().toISOString(),
      latencyMs,
    });

    if (failed) {
      throw new SmsProviderError(
        `Simulated delivery failure for ${maskRecipient(recipient)} (message ${messageId}).`,
      );
    }

    return {
      messageId,
      recipient,
      status: 'SENT',
      timestamp: new Date().toISOString(),
      latencyMs,
    };
  }

  /** Most recent simulated messages, newest last. */
  recent(limit = 50): SimulatedMessage[] {
    return this.history.slice(-limit);
  }

  get sentCount(): number {
    return this.history.filter((message) => message.status === 'SENT').length;
  }

  private record(message: SimulatedMessage): void {
    this.history.push(message);
    if (this.history.length > this.historySize) {
      this.history.splice(0, this.history.length - this.historySize);
    }
  }
}
