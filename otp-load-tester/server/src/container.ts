import type { AppConfig } from './config.js';
import { InMemoryTestRepository } from './infrastructure/repositories/InMemoryTestRepository.js';
import { PostgresTestRepository } from './infrastructure/repositories/PostgresTestRepository.js';
import type { TestRepository } from './infrastructure/repositories/TestRepository.js';
import { createSmsProvider } from './infrastructure/sms/index.js';
import type { SmsProvider } from './infrastructure/sms/SmsProvider.js';
import { EventBus } from './services/eventBus.js';
import { LoggingService } from './services/loggingService.js';
import { OtpService } from './services/otpService.js';
import { TestService } from './services/testService.js';

export interface Container {
  config: AppConfig;
  repository: TestRepository;
  provider: SmsProvider;
  bus: EventBus;
  logger: LoggingService;
  otpService: OtpService;
  testService: TestService;
  dispose(): Promise<void>;
}

export interface BuildOptions {
  /** Overrides for tests. */
  repository?: TestRepository;
  provider?: SmsProvider;
  consoleLogging?: boolean;
  watchdogGraceMs?: number;
}

/** Composition root: the only place that knows about every concrete adapter. */
export function buildContainer(config: AppConfig, options: BuildOptions = {}): Container {
  const repository =
    options.repository ??
    (config.persistence === 'postgres'
      ? new PostgresTestRepository(config.databaseUrl as string)
      : new InMemoryTestRepository());

  const provider = options.provider ?? createSmsProvider(config);
  const bus = new EventBus();
  const logger = new LoggingService({
    repository,
    bus,
    console: options.consoleLogging ?? !config.isProduction,
  });
  const otpService = new OtpService({ pepper: config.otpHashPepper });

  const testService = new TestService({
    repository,
    otpService,
    provider,
    logger,
    bus,
    limits: config.limits,
    smsMode: provider.mode,
    recipientAllowlist: config.recipientAllowlist,
    storePlaintextOtp: config.storePlaintextOtp && provider.mode === 'mock',
    ...(options.watchdogGraceMs !== undefined ? { watchdogGraceMs: options.watchdogGraceMs } : {}),
  });

  return {
    config,
    repository,
    provider,
    bus,
    logger,
    otpService,
    testService,
    async dispose() {
      // Stop live work first so nothing writes to a closed pool.
      await testService.stopAll('SERVER_SHUTDOWN');
      await provider.dispose?.();
      await repository.dispose?.();
    },
  };
}
