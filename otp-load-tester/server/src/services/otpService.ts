import { createHmac, randomInt } from 'node:crypto';
import { errors } from '../domain/errors.js';
import { OTP_LENGTH_RANGE } from '../domain/limits.js';

export interface GeneratedOtp {
  otp: string;
  /** HMAC-SHA256(otp, pepper) - what gets persisted. */
  hash: string;
  /** True when uniqueness could not be guaranteed within the OTP key space. */
  reused: boolean;
}

export interface OtpServiceOptions {
  /** Server-side secret mixed into the stored hash. */
  pepper: string;
  /** Injected for deterministic tests; must behave like crypto.randomInt. */
  randomIntImpl?: (min: number, max: number) => number;
}

/**
 * Cryptographically secure OTP generation.
 *
 * Uses `crypto.randomInt` (CSPRNG, rejection-sampled by Node so every digit is
 * uniformly distributed) - never `Math.random`.
 */
export class OtpService {
  private readonly pepper: string;
  private readonly randomIntImpl: (min: number, max: number) => number;

  constructor(options: OtpServiceOptions) {
    this.pepper = options.pepper;
    this.randomIntImpl = options.randomIntImpl ?? ((min, max) => randomInt(min, max));
  }

  assertValidLength(length: number): void {
    if (
      !Number.isInteger(length) ||
      length < OTP_LENGTH_RANGE.min ||
      length > OTP_LENGTH_RANGE.max
    ) {
      throw errors.validation(
        `OTP length must be an integer between ${OTP_LENGTH_RANGE.min} and ${OTP_LENGTH_RANGE.max}.`,
        { field: 'otpLength', received: length },
      );
    }
  }

  /** Generates a zero-padded numeric OTP of the requested length. */
  generate(length: number = OTP_LENGTH_RANGE.default): GeneratedOtp {
    this.assertValidLength(length);
    const otp = this.randomDigits(length);
    return { otp, hash: this.hash(otp), reused: false };
  }

  /**
   * Generates an OTP that is not already present in `issued`.
   *
   * When the requested count approaches the size of the key space, collisions
   * become unavoidable; rather than looping forever the service gives up after
   * `maxAttempts` and flags the value as reused so the caller can log it.
   */
  generateUnique(length: number, issued: ReadonlySet<string>, maxAttempts = 12): GeneratedOtp {
    this.assertValidLength(length);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const otp = this.randomDigits(length);
      if (!issued.has(otp)) return { otp, hash: this.hash(otp), reused: false };
    }
    const otp = this.randomDigits(length);
    return { otp, hash: this.hash(otp), reused: issued.has(otp) };
  }

  hash(otp: string): string {
    return createHmac('sha256', this.pepper).update(otp).digest('hex');
  }

  private randomDigits(length: number): string {
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += String(this.randomIntImpl(0, 10));
    }
    return out;
  }
}
