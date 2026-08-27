import { z } from 'zod';
import { OTP_LENGTH_RANGE, type SafetyLimits } from './limits.js';
import { errors } from './errors.js';
import type { TestConfig } from './types.js';

/**
 * A recipient is either a phone number in loose E.164 form or a synthetic test
 * identifier (preferred, and what the mock provider is designed for).
 */
const PHONE_RE = /^\+?[1-9]\d{5,14}$/;
const TEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export function isValidRecipient(value: string): boolean {
  return PHONE_RE.test(value) || TEST_ID_RE.test(value);
}

export function buildCreateTestSchema(limits: SafetyLimits) {
  return z
    .object({
      recipient: z
        .string()
        .trim()
        .min(3, 'Recipient is required.')
        .max(64)
        .refine(isValidRecipient, {
          message:
            'Recipient must be a phone number in E.164 form (e.g. +15551234567) or a test ' +
            'identifier such as TEST-USER-001.',
        }),
      otpLength: z.coerce
        .number()
        .int()
        .min(OTP_LENGTH_RANGE.min, `OTP length must be at least ${OTP_LENGTH_RANGE.min}.`)
        .max(OTP_LENGTH_RANGE.max, `OTP length must be at most ${OTP_LENGTH_RANGE.max}.`)
        .default(OTP_LENGTH_RANGE.default),
      messagesPerMinute: z.coerce
        .number()
        .int()
        .min(1, 'Messages per minute must be at least 1.')
        .max(
          limits.maxMessagesPerMinute,
          `Messages per minute may not exceed the configured limit of ${limits.maxMessagesPerMinute}.`,
        ),
      maxMessages: z.coerce
        .number()
        .int()
        .min(1, 'Maximum messages must be at least 1.')
        .max(
          limits.maxMessagesPerTest,
          `Maximum messages may not exceed the configured limit of ${limits.maxMessagesPerTest}.`,
        ),
      durationSeconds: z.coerce
        .number()
        .int()
        .min(1, 'Test duration must be at least 1 second.')
        .max(
          limits.maxDurationSeconds,
          `Test duration may not exceed the configured limit of ${limits.maxDurationSeconds} seconds.`,
        ),
      testName: z.string().trim().max(120).optional().nullable().default(null),
      authorizationAcknowledged: z.literal(true, {
        errorMap: () => ({
          message: 'You must confirm that you are authorized to test this recipient/system.',
        }),
      }),
    })
    .strict();
}

export type CreateTestInput = TestConfig;

/** Parses and normalises the create-test payload, throwing an `AppError`. */
export function parseCreateTest(payload: unknown, limits: SafetyLimits): CreateTestInput {
  const result = buildCreateTestSchema(limits).safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
    }));
    if (issues.some((i) => i.field === 'authorizationAcknowledged')) {
      throw errors.authorizationNotAcknowledged();
    }
    throw errors.validation('One or more test parameters are invalid.', issues);
  }
  return {
    ...result.data,
    testName: result.data.testName ?? null,
  };
}

/** Recipient allowlist check - enforced for every non-mock provider mode. */
export function assertRecipientAllowed(
  recipient: string,
  smsMode: string,
  allowlist: readonly string[],
): void {
  if (smsMode === 'mock') return;
  const normalised = recipient.trim().toLowerCase();
  const allowed = allowlist.some((entry) => entry.trim().toLowerCase() === normalised);
  if (!allowed) throw errors.recipientNotAllowed(recipient);
}

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().trim().max(20).optional(),
});

export const logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict();
