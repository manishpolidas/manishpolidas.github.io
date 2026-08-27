import { describe, expect, it } from 'vitest';
import { AppError } from '../domain/errors.js';
import { OtpService } from '../services/otpService.js';

const service = new OtpService({ pepper: 'unit-test-pepper' });

describe('OtpService', () => {
  it('generates an OTP of the requested length, digits only', () => {
    for (const length of [4, 5, 6, 7, 8]) {
      const { otp } = service.generate(length);
      expect(otp).toHaveLength(length);
      expect(otp).toMatch(/^\d+$/);
    }
  });

  it('defaults to 6 digits', () => {
    expect(service.generate().otp).toHaveLength(6);
  });

  it('rejects invalid OTP lengths', () => {
    for (const length of [0, 3, 9, 6.5, Number.NaN]) {
      expect(() => service.generate(length)).toThrowError(AppError);
    }
  });

  it('preserves leading zeros', () => {
    const zeroes = new OtpService({ pepper: 'p', randomIntImpl: () => 0 });
    expect(zeroes.generate(6).otp).toBe('000000');
  });

  it('produces a stable hash and never returns the plaintext in it', () => {
    const { otp, hash } = service.generate(6);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(service.hash(otp));
    expect(hash).not.toContain(otp);
  });

  it('uses a different hash for a different pepper', () => {
    const other = new OtpService({ pepper: 'another-pepper' });
    expect(other.hash('123456')).not.toBe(service.hash('123456'));
  });

  it('does not repeat values within a reasonable sample (randomness smoke test)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(service.generate(8).otp);
    // 8-digit space is 10^8; 500 draws should be collision free in practice.
    expect(seen.size).toBe(500);
  });

  it('spreads digits across the whole 0-9 range', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i += 1) {
      for (const digit of service.generate(6).otp) {
        counts.set(digit, (counts.get(digit) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(10);
    for (const count of counts.values()) {
      // 12000 digits over 10 buckets: ~1200 each. Very loose bounds.
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1600);
    }
  });

  it('generateUnique avoids values that were already issued', () => {
    const issued = new Set(['0000', '0001']);
    const sequence = ['0000', '0000', '0001', '4321'];
    let index = 0;
    const scripted = new OtpService({
      pepper: 'p',
      randomIntImpl: () => {
        // Feed the digits of the scripted OTPs one at a time.
        const otp = sequence[Math.floor(index / 4)] ?? '9999';
        const digit = otp[index % 4] ?? '9';
        index += 1;
        return Number(digit);
      },
    });
    const result = scripted.generateUnique(4, issued);
    expect(result.otp).toBe('4321');
    expect(result.reused).toBe(false);
  });

  it('generateUnique flags reuse when the key space is exhausted', () => {
    const constant = new OtpService({ pepper: 'p', randomIntImpl: () => 7 });
    const issued = new Set(['7777']);
    const result = constant.generateUnique(4, issued, 3);
    expect(result.otp).toBe('7777');
    expect(result.reused).toBe(true);
  });
});
