import { clampLimits, type SafetyLimits } from './domain/limits.js';
import type { SmsMode } from './domain/types.js';

export type Role = 'admin' | 'viewer';

export interface DashboardUser {
  username: string;
  /** scrypt hash (see infrastructure/security/password.ts). */
  passwordHash: string | null;
  /** Development-only plaintext password. Rejected when NODE_ENV=production. */
  devPassword: string | null;
  role: Role;
}

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  corsOrigins: string[];
  session: { secret: string; ttlSeconds: number; cookieName: string; csrfCookieName: string };
  users: DashboardUser[];
  otpHashPepper: string;
  smsMode: SmsMode;
  mock: { latencyMs: number; jitterMs: number; failureRate: number };
  sandbox: { apiUrl: string; apiKey: string; timeoutMs: number };
  authorized: { apiUrl: string; apiKey: string; timeoutMs: number };
  recipientAllowlist: string[];
  limits: SafetyLimits;
  apiRateLimitPerMinute: number;
  storePlaintextOtp: boolean;
  persistence: 'memory' | 'postgres';
  databaseUrl: string | null;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const smsMode = parseSmsMode(env.SMS_MODE);

  const config: AppConfig = {
    nodeEnv,
    isProduction,
    port: int(env.PORT, 4000),
    corsOrigins: list(env.CORS_ORIGINS ?? 'http://localhost:5173'),
    session: {
      secret: env.SESSION_SECRET ?? 'insecure-development-session-secret',
      ttlSeconds: int(env.SESSION_TTL_SECONDS, 3600),
      cookieName: 'otp_test_session',
      csrfCookieName: 'otp_test_csrf',
    },
    users: parseUsers(env),
    otpHashPepper: env.OTP_HASH_PEPPER ?? 'insecure-development-otp-pepper',
    smsMode,
    mock: {
      latencyMs: int(env.MOCK_LATENCY_MS, 120),
      jitterMs: int(env.MOCK_LATENCY_JITTER_MS, 80),
      failureRate: float(env.MOCK_FAILURE_RATE, 0.05),
    },
    sandbox: {
      apiUrl: env.SANDBOX_API_URL ?? '',
      apiKey: env.SANDBOX_API_KEY ?? '',
      timeoutMs: int(env.SANDBOX_TIMEOUT_MS, 8000),
    },
    authorized: {
      apiUrl: env.AUTHORIZED_API_URL ?? '',
      apiKey: env.AUTHORIZED_API_KEY ?? '',
      timeoutMs: int(env.AUTHORIZED_TIMEOUT_MS, 8000),
    },
    recipientAllowlist: list(env.RECIPIENT_ALLOWLIST ?? ''),
    limits: clampLimits({
      maxMessagesPerMinute: optInt(env.MAX_MESSAGES_PER_MINUTE),
      maxMessagesPerTest: optInt(env.MAX_MESSAGES_PER_TEST),
      maxDurationSeconds: optInt(env.MAX_DURATION_SECONDS),
      maxConcurrentTests: optInt(env.MAX_CONCURRENT_TESTS),
    }),
    apiRateLimitPerMinute: int(env.API_RATE_LIMIT_PER_MINUTE, 120),
    // Plaintext OTPs are only ever retained for the local simulator.
    storePlaintextOtp: smsMode === 'mock' && bool(env.STORE_PLAINTEXT_OTP, true),
    persistence: env.PERSISTENCE === 'postgres' ? 'postgres' : 'memory',
    databaseUrl: env.DATABASE_URL ?? null,
  };

  validate(config);
  return config;
}

function validate(config: AppConfig): void {
  const problems: string[] = [];

  if (config.users.length === 0) {
    problems.push(
      'No dashboard users configured. Set DASHBOARD_USERNAME plus DASHBOARD_PASSWORD_HASH ' +
        '(or DASHBOARD_USERS_JSON).',
    );
  }
  if (!config.users.some((u) => u.role === 'admin')) {
    problems.push('At least one dashboard user must have the "admin" role to execute tests.');
  }

  if (config.isProduction) {
    if (config.session.secret.startsWith('insecure-') || config.session.secret.length < 32) {
      problems.push('SESSION_SECRET must be set to at least 32 random characters in production.');
    }
    if (config.otpHashPepper.startsWith('insecure-')) {
      problems.push('OTP_HASH_PEPPER must be set in production.');
    }
    const withDevPassword = config.users.filter((u) => u.devPassword && !u.passwordHash);
    if (withDevPassword.length > 0) {
      problems.push(
        'Plaintext DASHBOARD_PASSWORD is not allowed in production. Use ' +
          '`npm run hash-password -- <password>` and set DASHBOARD_PASSWORD_HASH.',
      );
    }
  }

  if (config.smsMode === 'sandbox' && !config.sandbox.apiUrl) {
    problems.push('SMS_MODE=sandbox requires SANDBOX_API_URL.');
  }
  if (config.smsMode === 'authorized' && !config.authorized.apiUrl) {
    problems.push('SMS_MODE=authorized requires AUTHORIZED_API_URL.');
  }
  if (config.smsMode !== 'mock' && config.recipientAllowlist.length === 0) {
    problems.push(
      `SMS_MODE=${config.smsMode} requires a non-empty RECIPIENT_ALLOWLIST so that only ` +
        'recipients you are authorized to test can be targeted.',
    );
  }
  if (config.persistence === 'postgres' && !config.databaseUrl) {
    problems.push('PERSISTENCE=postgres requires DATABASE_URL.');
  }
  if (config.mock.failureRate < 0 || config.mock.failureRate > 1) {
    problems.push('MOCK_FAILURE_RATE must be between 0 and 1.');
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  }
}

function parseSmsMode(raw: string | undefined): SmsMode {
  switch ((raw ?? 'mock').toLowerCase()) {
    case 'sandbox':
      return 'sandbox';
    case 'authorized':
      return 'authorized';
    case 'mock':
    case '':
      return 'mock';
    default:
      throw new ConfigError(`Unknown SMS_MODE "${raw}". Use mock, sandbox or authorized.`);
  }
}

function parseUsers(env: Env): DashboardUser[] {
  const json = env.DASHBOARD_USERS_JSON?.trim();
  if (json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new ConfigError('DASHBOARD_USERS_JSON is not valid JSON.');
    }
    if (!Array.isArray(parsed)) throw new ConfigError('DASHBOARD_USERS_JSON must be an array.');
    return parsed.map((entry, index) => {
      const record = entry as Record<string, unknown>;
      const username = String(record.username ?? '').trim();
      if (!username) {
        throw new ConfigError(`DASHBOARD_USERS_JSON[${index}] is missing "username".`);
      }
      const role = record.role === 'viewer' ? 'viewer' : 'admin';
      const passwordHash = record.passwordHash ? String(record.passwordHash) : null;
      const devPassword = record.password ? String(record.password) : null;
      if (!passwordHash && !devPassword) {
        throw new ConfigError(
          `DASHBOARD_USERS_JSON[${index}] needs "passwordHash" (or "password" for development).`,
        );
      }
      return { username, role, passwordHash, devPassword };
    });
  }

  const username = (env.DASHBOARD_USERNAME ?? 'admin').trim();
  const passwordHash = env.DASHBOARD_PASSWORD_HASH?.trim() || null;
  const devPassword = env.DASHBOARD_PASSWORD?.trim() || null;
  if (!passwordHash && !devPassword) return [];
  return [{ username, passwordHash, devPassword, role: 'admin' }];
}

function int(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function optInt(raw: string | undefined): number | undefined {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) ? value : undefined;
}

function float(raw: string | undefined, fallback: number): number {
  const value = Number.parseFloat(raw ?? '');
  return Number.isFinite(value) ? value : fallback;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function list(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
