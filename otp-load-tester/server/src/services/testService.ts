import { randomUUID } from 'node:crypto';
import type { Role } from '../config.js';
import { errors } from '../domain/errors.js';
import type { SafetyLimits } from '../domain/limits.js';
import {
  isTerminal,
  type LogEntry,
  type OtpAttempt,
  type SmsMode,
  type StopReason,
  type TestSession,
  type TestSnapshot,
  type TestStatus,
} from '../domain/types.js';
import { assertRecipientAllowed, parseCreateTest } from '../domain/validation.js';
import type {
  ListSessionsResult,
  TestRepository,
} from '../infrastructure/repositories/TestRepository.js';
import type { SmsProvider } from '../infrastructure/sms/SmsProvider.js';
import type { EventBus } from './eventBus.js';
import type { LoggingService } from './loggingService.js';
import type { OtpService } from './otpService.js';
import { TestRunner } from './scheduler.js';
import { buildSnapshot } from './snapshot.js';
import { nowIso } from './time.js';

/** Statuses that occupy a concurrency slot. */
const ACTIVE_STATUSES: readonly TestStatus[] = ['RUNNING', 'PAUSED', 'STOPPING'];

export interface Actor {
  username: string;
  role: Role;
  ip?: string | null;
}

export interface TestServiceDeps {
  repository: TestRepository;
  otpService: OtpService;
  provider: SmsProvider;
  logger: LoggingService;
  bus: EventBus;
  limits: SafetyLimits;
  smsMode: SmsMode;
  recipientAllowlist: readonly string[];
  storePlaintextOtp: boolean;
  watchdogGraceMs?: number;
}

/**
 * Application service: owns the test lifecycle and the registry of live
 * runners. The API layer only translates HTTP to these calls.
 */
export class TestService {
  private readonly deps: TestServiceDeps;
  private readonly runners = new Map<string, TestRunner>();
  /** Guards against duplicate concurrent start requests for the same test. */
  private readonly starting = new Set<string>();

  constructor(deps: TestServiceDeps) {
    this.deps = deps;
  }

  get activeCount(): number {
    return [...this.runners.values()].filter((runner) => runner.isActive).length;
  }

  async createTest(payload: unknown, actor: Actor): Promise<TestSession> {
    this.assertCanExecute(actor);
    const input = parseCreateTest(payload, this.deps.limits);
    assertRecipientAllowed(input.recipient, this.deps.smsMode, this.deps.recipientAllowlist);
    this.deps.otpService.assertValidLength(input.otpLength);

    const session: TestSession = {
      ...input,
      id: `TEST-${nextShortId()}`,
      status: 'CREATED',
      smsMode: this.deps.smsMode,
      generated: 0,
      sent: 0,
      failed: 0,
      createdBy: actor.username,
      stopReason: null,
      createdAt: nowIso(),
      startedAt: null,
      pausedAt: null,
      stoppedAt: null,
      completedAt: null,
    };

    const created = await this.deps.repository.createSession(session);
    await this.deps.logger.audit({
      actor: actor.username,
      action: 'test.create',
      testId: created.id,
      ip: actor.ip ?? null,
      detail:
        `recipient=${this.deps.logger.mask(created.recipient)} mode=${created.smsMode} ` +
        `rate=${created.messagesPerMinute}/min max=${created.maxMessages} ` +
        `duration=${created.durationSeconds}s authorizationAcknowledged=true`,
    });
    await this.deps.logger.log(
      created.id,
      'info',
      'test.created',
      `Test created by ${actor.username} (${created.smsMode} mode).`,
    );
    this.deps.bus.publish({ type: 'test.created', payload: buildSnapshot(created) });
    return created;
  }

  async startTest(testId: string, actor: Actor): Promise<TestSession> {
    this.assertCanExecute(actor);
    if (this.starting.has(testId)) throw errors.alreadyRunning(testId);
    this.starting.add(testId);
    try {
      const session = await this.requireSession(testId);
      const runner = this.runners.get(testId);
      if (runner?.isActive) throw errors.alreadyRunning(testId);
      if (isTerminal(session.status)) throw errors.alreadyStopped(testId);
      if (session.status !== 'CREATED') throw errors.alreadyRunning(testId);

      const activeInStore = await this.deps.repository.countSessionsByStatus(ACTIVE_STATUSES);
      const active = Math.max(this.activeCount, activeInStore);
      if (active >= this.deps.limits.maxConcurrentTests) {
        throw errors.concurrencyLimit(this.deps.limits.maxConcurrentTests);
      }

      // Re-validate against current limits: configuration may have tightened
      // between creating and starting the test.
      assertRecipientAllowed(session.recipient, this.deps.smsMode, this.deps.recipientAllowlist);
      this.assertWithinLimits(session);

      const newRunner = new TestRunner({
        session,
        otpService: this.deps.otpService,
        provider: this.deps.provider,
        repository: this.deps.repository,
        logger: this.deps.logger,
        storePlaintextOtp: this.deps.storePlaintextOtp,
        watchdogGraceMs: this.deps.watchdogGraceMs,
        onSessionChange: (updated) => {
          this.deps.bus.publish({ type: 'test.update', payload: buildSnapshot(updated) });
        },
        onFinished: (updated) => {
          this.runners.delete(updated.id);
          this.deps.bus.publish({ type: 'test.finished', payload: buildSnapshot(updated) });
        },
      });
      this.runners.set(testId, newRunner);

      const started = await newRunner.start();
      await this.deps.logger.audit({
        actor: actor.username,
        action: 'test.start',
        testId,
        ip: actor.ip ?? null,
      });
      return started;
    } finally {
      this.starting.delete(testId);
    }
  }

  async pauseTest(testId: string, actor: Actor): Promise<TestSession> {
    this.assertCanExecute(actor);
    const runner = await this.requireRunner(testId);
    const session = await runner.pause();
    await this.deps.logger.audit({
      actor: actor.username,
      action: 'test.pause',
      testId,
      ip: actor.ip ?? null,
    });
    return session;
  }

  async resumeTest(testId: string, actor: Actor): Promise<TestSession> {
    this.assertCanExecute(actor);
    const runner = await this.requireRunner(testId);
    const session = await runner.resume();
    await this.deps.logger.audit({
      actor: actor.username,
      action: 'test.resume',
      testId,
      ip: actor.ip ?? null,
    });
    return session;
  }

  /**
   * Stops a test. Resolves only once the scheduler has exited and the terminal
   * status is persisted, so the caller can trust that no further OTP request
   * will be created.
   */
  async stopTest(testId: string, actor: Actor): Promise<TestSession> {
    this.assertCanExecute(actor);
    const runner = this.runners.get(testId);
    if (!runner) {
      const session = await this.requireSession(testId);
      if (isTerminal(session.status)) throw errors.alreadyStopped(testId);
      // Created-but-never-started: close it out without a scheduler.
      const stopped = await this.deps.repository.updateSession(testId, {
        status: 'STOPPED',
        stopReason: 'USER_STOP',
        stoppedAt: nowIso(),
      });
      await this.deps.logger.log(
        testId,
        'info',
        'test.finished',
        'Test STOPPED before it was started.',
      );
      this.deps.bus.publish({ type: 'test.finished', payload: buildSnapshot(stopped) });
      await this.deps.logger.audit({
        actor: actor.username,
        action: 'test.stop',
        testId,
        detail: 'stopped before start',
        ip: actor.ip ?? null,
      });
      return stopped;
    }

    const session = await runner.stop('USER_STOP');
    await this.deps.logger.audit({
      actor: actor.username,
      action: 'test.stop',
      testId,
      detail: `generated=${session.generated} sent=${session.sent} failed=${session.failed}`,
      ip: actor.ip ?? null,
    });
    return session;
  }

  async getTest(testId: string): Promise<{ session: TestSession; snapshot: TestSnapshot }> {
    const session = await this.requireSession(testId);
    return { session, snapshot: buildSnapshot(session) };
  }

  async listTests(options: {
    limit: number;
    offset: number;
    status?: string;
  }): Promise<ListSessionsResult & { snapshots: TestSnapshot[] }> {
    const status = options.status as TestStatus | undefined;
    const result = await this.deps.repository.listSessions({
      limit: options.limit,
      offset: options.offset,
      ...(status ? { status } : {}),
    });
    return { ...result, snapshots: result.items.map((session) => buildSnapshot(session)) };
  }

  async getLogs(testId: string, limit: number): Promise<LogEntry[]> {
    await this.requireSession(testId);
    return this.deps.repository.listLogs(testId, limit);
  }

  async getAttempts(testId: string, limit: number): Promise<OtpAttempt[]> {
    await this.requireSession(testId);
    return this.deps.repository.listAttempts(testId, limit);
  }

  async deleteTest(testId: string, actor: Actor): Promise<void> {
    this.assertCanExecute(actor);
    const session = await this.requireSession(testId);
    const runner = this.runners.get(testId);
    if (runner?.isActive) {
      // Never delete a live test out from under its scheduler.
      await runner.stop('USER_STOP');
    }
    await this.deps.repository.deleteSession(session.id);
    this.runners.delete(testId);
    this.deps.bus.publish({ type: 'test.deleted', payload: { testId } });
    await this.deps.logger.audit({
      actor: actor.username,
      action: 'test.delete',
      testId,
      ip: actor.ip ?? null,
    });
  }

  /** Emergency stop: cancels every live run. Used by the UI and by shutdown. */
  async stopAll(reason: StopReason, actor?: Actor): Promise<string[]> {
    if (actor) this.assertCanExecute(actor);
    const runners = [...this.runners.values()].filter((runner) => runner.isActive);
    await Promise.allSettled(runners.map((runner) => runner.stop(reason)));
    this.runners.clear();
    if (actor) {
      await this.deps.logger.audit({
        actor: actor.username,
        action: 'test.stop_all',
        detail: `reason=${reason} count=${runners.length}`,
        ip: actor.ip ?? null,
      });
    }
    return runners.map((runner) => runner.testId);
  }

  /** Closes out sessions orphaned by a crash or restart. */
  async reconcileInterrupted(): Promise<string[]> {
    const ids = await this.deps.repository.reconcileInterruptedSessions();
    for (const id of ids) {
      await this.deps.logger.log(
        id,
        'warn',
        'test.interrupted',
        'Marked FAILED: the server restarted while this test was active. Scheduled work does not survive a restart.',
      );
    }
    return ids;
  }

  private async requireSession(testId: string): Promise<TestSession> {
    const session = await this.deps.repository.getSession(testId);
    if (!session) throw errors.notFound(testId);
    return session;
  }

  private async requireRunner(testId: string): Promise<TestRunner> {
    const runner = this.runners.get(testId);
    if (runner?.isActive) return runner;
    const session = await this.requireSession(testId);
    if (isTerminal(session.status)) throw errors.alreadyStopped(testId);
    throw errors.notRunning(testId);
  }

  private assertCanExecute(actor: Actor): void {
    if (actor.role !== 'admin') {
      throw errors.forbidden(
        'Test execution requires the "admin" role. Your account is read-only.',
      );
    }
  }

  private assertWithinLimits(session: TestSession): void {
    const { limits } = this.deps;
    if (
      session.messagesPerMinute > limits.maxMessagesPerMinute ||
      session.maxMessages > limits.maxMessagesPerTest ||
      session.durationSeconds > limits.maxDurationSeconds
    ) {
      throw errors.validation(
        'This test exceeds the current safety limits and can no longer be started.',
        {
          limits,
          test: {
            messagesPerMinute: session.messagesPerMinute,
            maxMessages: session.maxMessages,
            durationSeconds: session.durationSeconds,
          },
        },
      );
    }
  }
}

function nextShortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
}
