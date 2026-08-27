import { describe, expect, it } from 'vitest';
import { AppError } from '../domain/errors.js';
import { DEFAULT_LIMITS, HARD_CAPS, clampLimits } from '../domain/limits.js';
import { assertRecipientAllowed, isValidRecipient, parseCreateTest } from '../domain/validation.js';
import { ConfigError, loadConfig } from '../config.js';
import { baseTestPayload, testConfig } from './helpers.js';

const limits = DEFAULT_LIMITS;

/** Returns the AppError code thrown by `fn`, or null when nothing was thrown. */
function codeOfThrown(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof AppError ? error.code : `unexpected:${String(error)}`;
  }
}

describe('recipient validation', () => {
  it('accepts E.164 numbers and test identifiers', () => {
    for (const value of ['+15551234567', '15551234567', 'TEST-USER-001', 'load_test.01']) {
      expect(isValidRecipient(value)).toBe(true);
    }
  });

  it('rejects malformed recipients', () => {
    for (const value of ['', 'ab', '+0123', 'user@example.com', '../etc/passwd', '+1 555 123']) {
      expect(isValidRecipient(value)).toBe(false);
    }
  });
});

describe('parseCreateTest', () => {
  it('applies defaults and normalises the payload', () => {
    const parsed = parseCreateTest(
      {
        recipient: '  TEST-USER-001 ',
        messagesPerMinute: 10,
        maxMessages: 25,
        durationSeconds: 120,
        authorizationAcknowledged: true,
      },
      limits,
    );
    expect(parsed).toMatchObject({
      recipient: 'TEST-USER-001',
      otpLength: 6,
      messagesPerMinute: 10,
      maxMessages: 25,
      durationSeconds: 120,
      testName: null,
    });
  });

  it('requires the authorization acknowledgement', () => {
    expect(
      codeOfThrown(() =>
        parseCreateTest(baseTestPayload({ authorizationAcknowledged: false }), limits),
      ),
    ).toBe('AUTHORIZATION_NOT_ACKNOWLEDGED');
    expect(
      codeOfThrown(() =>
        parseCreateTest(baseTestPayload({ authorizationAcknowledged: undefined }), limits),
      ),
    ).toBe('AUTHORIZATION_NOT_ACKNOWLEDGED');
  });

  it('rejects rates above the configured limit', () => {
    try {
      parseCreateTest(
        baseTestPayload({ messagesPerMinute: limits.maxMessagesPerMinute + 1 }),
        limits,
      );
      throw new Error('expected a validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify((error as AppError).details)).toContain('messagesPerMinute');
    }
  });

  it('rejects message counts and durations above the configured limits', () => {
    expect(() =>
      parseCreateTest(baseTestPayload({ maxMessages: limits.maxMessagesPerTest + 1 }), limits),
    ).toThrowError(AppError);
    expect(() =>
      parseCreateTest(baseTestPayload({ durationSeconds: limits.maxDurationSeconds + 1 }), limits),
    ).toThrowError(AppError);
  });

  it('rejects OTP lengths outside 4-8', () => {
    expect(() => parseCreateTest(baseTestPayload({ otpLength: 3 }), limits)).toThrowError(AppError);
    expect(() => parseCreateTest(baseTestPayload({ otpLength: 9 }), limits)).toThrowError(AppError);
  });

  it('rejects unknown fields', () => {
    expect(() => parseCreateTest(baseTestPayload({ bypassRateLimit: true }), limits)).toThrowError(
      AppError,
    );
  });
});

describe('safety limits', () => {
  it('clamps operator configuration to the compiled-in hard caps', () => {
    const clamped = clampLimits({
      maxMessagesPerMinute: 10_000,
      maxMessagesPerTest: 1_000_000,
      maxDurationSeconds: 86_400,
      maxConcurrentTests: 500,
    });
    expect(clamped).toEqual(HARD_CAPS);
  });

  it('falls back to defaults for missing or nonsense values', () => {
    expect(clampLimits({})).toEqual(DEFAULT_LIMITS);
    expect(clampLimits({ maxMessagesPerMinute: -5 }).maxMessagesPerMinute).toBe(1);
  });
});

describe('recipient allowlist', () => {
  it('is not enforced in mock mode', () => {
    expect(() => assertRecipientAllowed('TEST-USER-001', 'mock', [])).not.toThrow();
  });

  it('is enforced for sandbox and authorized modes', () => {
    expect(
      codeOfThrown(() => assertRecipientAllowed('+15551234567', 'sandbox', ['+15559999999'])),
    ).toBe('RECIPIENT_NOT_ALLOWED');
    expect(() =>
      assertRecipientAllowed('+15551234567', 'authorized', ['+15551234567']),
    ).not.toThrow();
  });
});

describe('configuration', () => {
  it('defaults to local mock mode with in-memory persistence', () => {
    const config = testConfig();
    expect(config.smsMode).toBe('mock');
    expect(config.persistence).toBe('memory');
    expect(config.storePlaintextOtp).toBe(true);
  });

  it('never keeps plaintext OTPs outside mock mode', () => {
    const config = testConfig({
      SMS_MODE: 'sandbox',
      SANDBOX_API_URL: 'https://sandbox.example.test',
      RECIPIENT_ALLOWLIST: 'TEST-USER-001',
      STORE_PLAINTEXT_OTP: 'true',
    });
    expect(config.storePlaintextOtp).toBe(false);
  });

  it('refuses non-mock modes without an allowlist', () => {
    expect(() =>
      testConfig({ SMS_MODE: 'sandbox', SANDBOX_API_URL: 'https://sandbox.example.test' }),
    ).toThrowError(ConfigError);
  });

  it('refuses authorized mode without an endpoint', () => {
    expect(() =>
      testConfig({ SMS_MODE: 'authorized', RECIPIENT_ALLOWLIST: '+15551234567' }),
    ).toThrowError(ConfigError);
  });

  it('refuses a plaintext dashboard password in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'x'.repeat(40),
        OTP_HASH_PEPPER: 'real-pepper',
        DASHBOARD_USERNAME: 'admin',
        DASHBOARD_PASSWORD: 'plaintext-password',
      }),
    ).toThrowError(ConfigError);
  });

  it('refuses a default session secret in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        OTP_HASH_PEPPER: 'real-pepper',
        DASHBOARD_USERNAME: 'admin',
        DASHBOARD_PASSWORD_HASH: 'scrypt$aa$bb',
      }),
    ).toThrowError(ConfigError);
  });

  it('refuses to start with no users configured', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).toThrowError(ConfigError);
  });
});
