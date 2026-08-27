import { randomUUID } from 'node:crypto';
import { WATCHDOG_GRACE_MS } from '../domain/limits.js';
import { errors } from '../domain/errors.js';
import type { OtpAttempt, StopReason, TestSession, TestStatus } from '../domain/types.js';
import type { TestRepository } from '../infrastructure/repositories/TestRepository.js';
import { SmsProviderError, type SmsProvider } from '../infrastructure/sms/SmsProvider.js';
import type { LoggingService } from './loggingService.js';
import type { OtpService } from './otpService.js';
import { CancelledError, delay, isCancellation, nowIso } from './time.js';

export interface TestRunnerDeps {
  session: TestSession;
  otpService: OtpService;
  provider: SmsProvider;
  repository: TestRepository;
  logger: LoggingService;
  /** Local mock mode only; forced false elsewhere by config. */
  storePlaintextOtp: boolean;
  /** Called whenever the persisted session row changes. */
  onSessionChange: (session: TestSession) => void;
  /** Called exactly once, after the run reaches a terminal status. */
  onFinished: (session: TestSession) => void;
  watchdogGraceMs?: number;
  now?: () => number;
}

/**
 * Drives one test session.
 *
 * Design notes that make Stop reliable:
 *  - a single `AbortController` owns the whole run: the pacing sleep, the pause
 *    gate and the in-flight provider call all observe the same signal;
 *  - the loop re-checks `signal.aborted` immediately before it generates an OTP,
 *    so no request can be created after Stop is issued;
 *  - exactly one send is in flight at a time, so "wait for running work to
 *    finish" is bounded by one provider call (which is itself aborted);
 *  - `stop()` resolves only after the loop has exited and the terminal status is
 *    persisted, and it is idempotent.
 */
export class TestRunner {
  private readonly deps: TestRunnerDeps;
  private readonly controller = new AbortController();
  private readonly issuedOtps = new Set<string>();
  private readonly now: () => number;

  private session: TestSession;
  private sequence = 0;
  private startCalled = false;
  private loopPromise: Promise<void> | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private pauseGate: { promise: Promise<void>; release: () => void } | null = null;
  private stopPromise: Promise<TestSession> | null = null;
  private finished = false;
  private slowProviderWarned = false;

  constructor(deps: TestRunnerDeps) {
    this.deps = deps;
    this.session = deps.session;
    this.now = deps.now ?? Date.now;
  }

  get testId(): string {
    return this.session.id;
  }

  get status(): TestStatus {
    return this.session.status;
  }

  get current(): TestSession {
    return this.session;
  }

  get isActive(): boolean {
    return !this.finished;
  }

  /** Transitions the session to RUNNING and starts the scheduler loop. */
  async start(): Promise<TestSession> {
    if (this.startCalled) throw errors.alreadyRunning(this.session.id);
    this.startCalled = true;

    await this.patch({ status: 'RUNNING', startedAt: nowIso(), stopReason: null });
    await this.deps.logger.log(
      this.testId,
      'info',
      'test.started',
      `Test started - recipient ${this.deps.logger.mask(this.session.recipient)}, ` +
        `${this.session.messagesPerMinute}/minute, max ${this.session.maxMessages} messages, ` +
        `${this.session.durationSeconds}s duration, provider ${this.deps.provider.name}.`,
    );

    this.armWatchdog();
    this.loopPromise = this.loop();
    return this.session;
  }

  async pause(): Promise<TestSession> {
    if (this.session.status !== 'RUNNING') throw errors.notRunning(this.testId);
    if (!this.pauseGate) {
      let release = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.pauseGate = { promise, release };
    }
    await this.patch({ status: 'PAUSED', pausedAt: nowIso() });
    await this.deps.logger.log(this.testId, 'info', 'test.paused', 'Test paused by operator.');
    return this.session;
  }

  async resume(): Promise<TestSession> {
    if (this.session.status !== 'PAUSED') throw errors.notPaused(this.testId);
    await this.patch({ status: 'RUNNING', pausedAt: null });
    this.releasePauseGate();
    await this.deps.logger.log(this.testId, 'info', 'test.resumed', 'Test resumed by operator.');
    return this.session;
  }

  /**
   * Cancels the run. Safe to call repeatedly and from any state; resolves once
   * the loop has exited and the terminal status has been persisted.
   */
  stop(reason: StopReason = 'USER_STOP'): Promise<TestSession> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop(reason);
    return this.stopPromise;
  }

  private async performStop(reason: StopReason): Promise<TestSession> {
    if (this.finished) return this.session;

    // 1. Announce intent so the API/dashboard immediately stop offering "start".
    if (this.session.status === 'RUNNING' || this.session.status === 'PAUSED') {
      await this.patch({ status: 'STOPPING' });
    }

    // 2. Release the pause gate first, otherwise a paused loop would never
    //    reach the point where it observes the abort.
    this.releasePauseGate();

    // 3. One abort cancels the pacing sleep and the in-flight provider call, and
    //    blocks the creation of any further OTP request.
    this.controller.abort();
    this.clearWatchdog();

    // 4. Wait for already-running work to unwind (bounded: one send).
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }

    // 5. Record the terminal state.
    return this.finalize(reason);
  }

  // ---------------------------------------------------------------- internals

  private async loop(): Promise<void> {
    const intervalMs = 60_000 / this.session.messagesPerMinute;
    const durationMs = this.session.durationSeconds * 1000;
    const startedAtMs = this.session.startedAt ? Date.parse(this.session.startedAt) : this.now();
    let nextDispatchAt = this.now();

    try {
      while (!this.controller.signal.aborted) {
        await this.waitWhilePaused();
        if (this.controller.signal.aborted) break;

        if (this.session.generated >= this.session.maxMessages) {
          void this.stop('MAX_MESSAGES_REACHED').catch(reportStopFailure);
          return;
        }
        if (this.now() - startedAtMs >= durationMs) {
          void this.stop('DURATION_ELAPSED').catch(reportStopFailure);
          return;
        }

        const waitMs = nextDispatchAt - this.now();
        if (waitMs > 0) {
          // Never sleep past the configured duration.
          const remainingMs = durationMs - (this.now() - startedAtMs);
          await delay(Math.min(waitMs, Math.max(0, remainingMs)), this.controller.signal);
        }
        if (this.controller.signal.aborted) break;
        if (this.now() - startedAtMs >= durationMs) {
          void this.stop('DURATION_ELAPSED').catch(reportStopFailure);
          return;
        }
        if (this.session.status === 'PAUSED') continue;

        // Rate pacing: advance from the scheduled slot (drift correction) but
        // never burst to catch up after a slow send.
        nextDispatchAt = Math.max(nextDispatchAt + intervalMs, this.now());

        await this.dispatchOne();
      }
    } catch (error) {
      if (isCancellation(error)) return; // Stop() owns the finalisation.
      await this.deps.logger.log(
        this.testId,
        'error',
        'test.error',
        `Scheduler aborted: ${describe(error)}`,
      );
      void this.stop('FATAL_ERROR').catch(reportStopFailure);
    }
  }

  /** Generates and sends exactly one OTP, recording the outcome. */
  private async dispatchOne(): Promise<void> {
    // Final guard: nothing is created once Stop has been issued.
    if (this.controller.signal.aborted) return;

    this.sequence += 1;
    const sequence = this.sequence;
    const { otp, hash, reused } = this.deps.otpService.generateUnique(
      this.session.otpLength,
      this.issuedOtps,
    );
    this.issuedOtps.add(otp);

    const attempt: OtpAttempt = {
      id: randomUUID(),
      testId: this.testId,
      sequence,
      recipient: this.session.recipient,
      otpHash: hash,
      otpPlaintext: this.deps.storePlaintextOtp ? otp : null,
      status: 'PENDING',
      providerMessageId: null,
      errorMessage: null,
      latencyMs: null,
      createdAt: nowIso(),
      completedAt: null,
    };

    try {
      await this.deps.repository.createAttempt(attempt);
    } catch (error) {
      await this.deps.logger.log(
        this.testId,
        'error',
        'attempt.persist_failed',
        `Could not persist attempt #${sequence}: ${describe(error)}`,
      );
    }

    await this.patch({ generated: this.session.generated + 1 });
    await this.deps.logger.log(
      this.testId,
      reused ? 'warn' : 'info',
      'otp.generated',
      `OTP generated #${sequence} ${this.deps.storePlaintextOtp ? otp : `hash:${hash.slice(0, 8)}`}` +
        (reused ? ' (key space exhausted - value repeats a previous OTP)' : ''),
    );

    const startedAt = this.now();
    try {
      const result = await this.deps.provider.sendOtp(this.session.recipient, otp, {
        testId: this.testId,
        sequence,
        signal: this.controller.signal,
      });
      await this.deps.repository.updateAttempt(attempt.id, {
        status: 'SENT',
        providerMessageId: result.messageId,
        latencyMs: result.latencyMs,
        completedAt: nowIso(),
      });
      await this.patch({ sent: this.session.sent + 1 });
      await this.deps.logger.log(
        this.testId,
        'info',
        'sms.simulated',
        `SMS ${this.deps.provider.mode === 'mock' ? 'simulated' : 'submitted'} SUCCESS ` +
          `#${sequence} messageId=${result.messageId} latency=${result.latencyMs}ms`,
      );
      this.warnIfSlow(result.latencyMs);
    } catch (error) {
      if (isCancellation(error)) {
        await this.deps.repository.updateAttempt(attempt.id, {
          status: 'CANCELLED',
          errorMessage: 'Cancelled by Stop request.',
          latencyMs: this.now() - startedAt,
          completedAt: nowIso(),
        });
        await this.deps.logger.log(
          this.testId,
          'warn',
          'sms.cancelled',
          `In-flight send #${sequence} cancelled by Stop.`,
        );
        throw error instanceof CancelledError ? error : new CancelledError();
      }

      const message =
        error instanceof SmsProviderError ? error.message : `Unexpected error: ${describe(error)}`;
      await this.deps.repository.updateAttempt(attempt.id, {
        status: 'FAILED',
        errorMessage: message,
        latencyMs: this.now() - startedAt,
        completedAt: nowIso(),
      });
      await this.patch({ failed: this.session.failed + 1 });
      await this.deps.logger.log(
        this.testId,
        'warn',
        'sms.simulated',
        `SMS ${this.deps.provider.mode === 'mock' ? 'simulated' : 'submitted'} FAILURE #${sequence} - ${message}`,
      );
    }
  }

  private warnIfSlow(latencyMs: number): void {
    const intervalMs = 60_000 / this.session.messagesPerMinute;
    if (latencyMs > intervalMs && !this.slowProviderWarned) {
      this.slowProviderWarned = true;
      void this.deps.logger.log(
        this.testId,
        'warn',
        'rate.degraded',
        `Provider latency (${latencyMs}ms) exceeds the ${Math.round(intervalMs)}ms send interval; ` +
          'the observed rate will be lower than configured.',
      );
    }
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.session.status === 'PAUSED' && !this.controller.signal.aborted) {
      const gate = this.pauseGate;
      if (!gate) return;
      await gate.promise;
    }
  }

  private releasePauseGate(): void {
    this.pauseGate?.release();
    this.pauseGate = null;
  }

  private armWatchdog(): void {
    const timeoutMs =
      this.session.durationSeconds * 1000 + (this.deps.watchdogGraceMs ?? WATCHDOG_GRACE_MS);
    this.watchdog = setTimeout(() => {
      void this.stop('WATCHDOG_TIMEOUT').catch(reportStopFailure);
    }, timeoutMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private async finalize(reason: StopReason): Promise<TestSession> {
    if (this.finished) return this.session;
    this.finished = true;
    this.clearWatchdog();

    const status = finalStatusFor(reason);
    const at = nowIso();
    await this.patch({
      status,
      stopReason: reason,
      stoppedAt: at,
      completedAt: status === 'COMPLETED' ? at : this.session.completedAt,
    });

    await this.deps.logger.log(
      this.testId,
      reason === 'FATAL_ERROR' ? 'error' : 'info',
      'test.finished',
      `Test ${status} (${reason}) - generated ${this.session.generated}, sent ${this.session.sent}, ` +
        `failed ${this.session.failed}. No further OTP requests will be created.`,
    );
    this.deps.onFinished(this.session);
    return this.session;
  }

  /** Persists a partial session update and notifies listeners. */
  private async patch(patch: Partial<TestSession>): Promise<void> {
    this.session = { ...this.session, ...patch };
    try {
      this.session = await this.deps.repository.updateSession(this.testId, patch);
    } catch (error) {
      // Keep the run observable even if storage is momentarily unavailable.
      console.error(`[scheduler] failed to persist session ${this.testId}: ${describe(error)}`);
    }
    this.deps.onSessionChange(this.session);
  }
}

export function finalStatusFor(reason: StopReason): TestStatus {
  switch (reason) {
    case 'MAX_MESSAGES_REACHED':
    case 'DURATION_ELAPSED':
    case 'WATCHDOG_TIMEOUT':
      return 'COMPLETED';
    case 'FATAL_ERROR':
      return 'FAILED';
    case 'USER_STOP':
    case 'SERVER_SHUTDOWN':
    default:
      return 'STOPPED';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failed stop is logged loudly but must never become an unhandled rejection. */
function reportStopFailure(error: unknown): void {
  console.error(`[scheduler] stop sequence failed: ${describe(error)}`);
}
