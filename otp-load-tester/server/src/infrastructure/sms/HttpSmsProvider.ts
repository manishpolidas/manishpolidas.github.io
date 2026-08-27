import type { SmsMode } from '../../domain/types.js';
import { isCancellation } from '../../services/time.js';
import {
  SmsProviderError,
  maskRecipient,
  type SendOtpContext,
  type SendOtpResult,
  type SmsProvider,
} from './SmsProvider.js';

export interface HttpSmsProviderOptions {
  apiUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Base HTTP provider for vendor endpoints. Credentials are read from
 * configuration (never from the client) and are never logged or echoed back to
 * the dashboard.
 */
export abstract class HttpSmsProvider implements SmsProvider {
  abstract readonly name: string;
  abstract readonly mode: SmsMode;

  protected readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpSmsProviderOptions) {
    if (!options.apiUrl) {
      throw new Error(`${this.constructor.name} requires an API URL.`);
    }
    this.apiUrl = options.apiUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async sendOtp(recipient: string, otp: string, context: SendOtpContext): Promise<SendOtpResult> {
    const startedAt = Date.now();
    // The caller's signal (Stop) and our timeout both cancel the request.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const forwardAbort = () => controller.abort();
    if (context.signal) {
      if (context.signal.aborted) controller.abort();
      else context.signal.addEventListener('abort', forwardAbort, { once: true });
    }
    const signal = controller.signal;

    try {
      const response = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(this.buildPayload(recipient, otp, context)),
        signal,
      });

      if (!response.ok) {
        const body = await safeText(response);
        throw new SmsProviderError(
          `${this.name} rejected the send for ${maskRecipient(recipient)}: HTTP ${response.status}` +
            (body ? ` - ${body.slice(0, 200)}` : ''),
          'PROVIDER_ERROR',
          response.status >= 500,
        );
      }

      const payload = (await safeJson(response)) as Record<string, unknown> | null;
      const messageId =
        stringOrNull(payload?.messageId) ??
        stringOrNull(payload?.sid) ??
        stringOrNull(payload?.id) ??
        `UNKNOWN-${Date.now()}`;

      return {
        messageId,
        recipient,
        status: 'SENT',
        timestamp: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      // A Stop-driven abort must surface as a cancellation, not a failure.
      if (context.signal?.aborted && isCancellation(error)) throw error;
      if (isCancellation(error)) {
        throw new SmsProviderError(
          `${this.name} timed out after ${this.timeoutMs}ms.`,
          'PROVIDER_TIMEOUT',
          true,
        );
      }
      if (error instanceof SmsProviderError) throw error;
      throw new SmsProviderError(
        `${this.name} transport error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  protected buildPayload(
    recipient: string,
    otp: string,
    context: SendOtpContext,
  ): Record<string, unknown> {
    return {
      recipient,
      message: `Your verification code is ${otp}`,
      metadata: { testId: context.testId, sequence: context.sequence, source: 'otp-load-tester' },
    };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
