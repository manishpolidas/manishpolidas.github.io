import { describe, expect, it } from 'vitest';
import { MockSmsProvider } from '../infrastructure/sms/MockSmsProvider.js';
import { SmsProviderError, maskRecipient } from '../infrastructure/sms/SmsProvider.js';
import { createSmsProvider } from '../infrastructure/sms/index.js';
import { isCancellation } from '../services/time.js';
import { testConfig } from './helpers.js';

const context = { testId: 'TEST-1', sequence: 1 };

describe('MockSmsProvider', () => {
  it('simulates a successful delivery and returns a message id', async () => {
    const provider = new MockSmsProvider({ latencyMs: 0, jitterMs: 0, failureRate: 0 });
    const result = await provider.sendOtp('TEST-USER-001', '483921', context);

    expect(result.status).toBe('SENT');
    expect(result.recipient).toBe('TEST-USER-001');
    expect(result.messageId).toMatch(/^TEST-\d{5}-[0-9a-f]{8}$/);
    expect(Date.parse(result.timestamp)).not.toBeNaN();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records every simulated message', async () => {
    const provider = new MockSmsProvider({ latencyMs: 0, jitterMs: 0, failureRate: 0 });
    await provider.sendOtp('TEST-USER-001', '111111', context);
    await provider.sendOtp('TEST-USER-001', '222222', { ...context, sequence: 2 });

    const history = provider.recent();
    expect(history).toHaveLength(2);
    expect(history.map((message) => message.otp)).toEqual(['111111', '222222']);
    expect(provider.sentCount).toBe(2);
  });

  it('simulates failures according to the configured rate', async () => {
    const provider = new MockSmsProvider({
      latencyMs: 0,
      jitterMs: 0,
      failureRate: 1,
      random: () => 0,
    });
    await expect(provider.sendOtp('TEST-USER-001', '123456', context)).rejects.toBeInstanceOf(
      SmsProviderError,
    );
    expect(provider.recent()[0]?.status).toBe('FAILED');
  });

  it('applies artificial latency', async () => {
    const provider = new MockSmsProvider({ latencyMs: 60, jitterMs: 0, failureRate: 0 });
    const startedAt = Date.now();
    await provider.sendOtp('TEST-USER-001', '123456', context);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it('aborts an in-flight send when the signal is cancelled', async () => {
    const provider = new MockSmsProvider({ latencyMs: 5_000, jitterMs: 0, failureRate: 0 });
    const controller = new AbortController();
    const pending = provider.sendOtp('TEST-USER-001', '123456', {
      ...context,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toSatisfy(isCancellation);
  });

  it('performs no network I/O (no fetch is required)', async () => {
    const provider = new MockSmsProvider({ latencyMs: 0, jitterMs: 0, failureRate: 0 });
    const originalFetch = globalThis.fetch;
    // Any attempt to reach the network would throw here.
    (globalThis as { fetch: unknown }).fetch = () => {
      throw new Error('the mock provider must not use the network');
    };
    try {
      await expect(provider.sendOtp('TEST-USER-001', '123456', context)).resolves.toMatchObject({
        status: 'SENT',
      });
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });
});

describe('provider factory', () => {
  it('defaults to the local mock simulator', () => {
    const provider = createSmsProvider(testConfig());
    expect(provider.mode).toBe('mock');
    expect(provider).toBeInstanceOf(MockSmsProvider);
  });

  it('builds a sandbox provider only when it is fully configured', () => {
    const provider = createSmsProvider(
      testConfig({
        SMS_MODE: 'sandbox',
        SANDBOX_API_URL: 'https://sandbox.example.test/send',
        SANDBOX_API_KEY: 'sandbox-key',
        RECIPIENT_ALLOWLIST: 'TEST-USER-001',
      }),
    );
    expect(provider.mode).toBe('sandbox');
  });
});

describe('maskRecipient', () => {
  it('keeps the shape but hides the identity', () => {
    expect(maskRecipient('+15551234567')).toBe('+1********67');
    expect(maskRecipient('TEST')).toBe('****');
  });
});
