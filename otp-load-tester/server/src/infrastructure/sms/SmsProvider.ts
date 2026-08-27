import type { SmsMode } from '../../domain/types.js';

export interface SendOtpContext {
  testId: string;
  sequence: number;
  /** Aborting this signal must cancel the in-flight send. */
  signal?: AbortSignal;
}

export interface SendOtpResult {
  messageId: string;
  recipient: string;
  status: 'SENT';
  timestamp: string;
  latencyMs: number;
}

export class SmsProviderError extends Error {
  readonly code: 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT';
  readonly retryable: boolean;

  constructor(
    message: string,
    code: 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT' = 'PROVIDER_ERROR',
    retryable = true,
  ) {
    super(message);
    this.name = 'SmsProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Transport abstraction. The application never depends on a concrete SMS
 * vendor: swapping `MockSmsProvider` for a sandbox or authorized provider is a
 * configuration change, not a code change.
 */
export interface SmsProvider {
  readonly name: string;
  readonly mode: SmsMode;
  /** Delivers `otp` to `recipient`. Rejects with `SmsProviderError` on failure. */
  sendOtp(recipient: string, otp: string, context: SendOtpContext): Promise<SendOtpResult>;
  /** Optional cleanup on shutdown. */
  dispose?(): Promise<void> | void;
}

/** Masks a recipient for logging: keeps shape, hides the identity. */
export function maskRecipient(recipient: string): string {
  if (recipient.length <= 4) return '*'.repeat(recipient.length);
  return `${recipient.slice(0, 2)}${'*'.repeat(recipient.length - 4)}${recipient.slice(-2)}`;
}
