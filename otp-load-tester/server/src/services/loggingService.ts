import { randomUUID } from 'node:crypto';
import type { LogEntry, LogLevel } from '../domain/types.js';
import type { TestRepository } from '../infrastructure/repositories/TestRepository.js';
import { maskRecipient } from '../infrastructure/sms/SmsProvider.js';
import type { EventBus } from './eventBus.js';
import { nowIso } from './time.js';

export interface LoggingServiceOptions {
  repository: TestRepository;
  bus: EventBus;
  /** Mirror activity to stdout. Disabled in tests to keep output readable. */
  console?: boolean;
}

/**
 * Per-test activity log plus the append-only audit trail.
 *
 * Writes here are best-effort: a storage hiccup must never take down a running
 * test, so failures are reported to stderr and swallowed.
 */
export class LoggingService {
  private readonly repository: TestRepository;
  private readonly bus: EventBus;
  private readonly toConsole: boolean;

  constructor(options: LoggingServiceOptions) {
    this.repository = options.repository;
    this.bus = options.bus;
    this.toConsole = options.console ?? true;
  }

  /** Records an activity-log line and streams it to connected dashboards. */
  async log(testId: string, level: LogLevel, event: string, message: string): Promise<LogEntry> {
    const entry: LogEntry = {
      id: randomUUID(),
      testId,
      at: nowIso(),
      level,
      event,
      message,
    };
    this.bus.publish({ type: 'test.log', payload: entry });
    if (this.toConsole) {
      const line = `[${entry.at}] [${testId}] ${event}: ${message}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    try {
      await this.repository.appendLog(entry);
    } catch (error) {
      console.error('[logging] failed to persist activity log', describe(error));
    }
    return entry;
  }

  /** Security-relevant actions: who did what, to which test, from where. */
  async audit(params: {
    actor: string;
    action: string;
    testId?: string | null;
    detail?: string | null;
    ip?: string | null;
  }): Promise<void> {
    try {
      await this.repository.appendAudit({
        id: randomUUID(),
        at: nowIso(),
        actor: params.actor,
        action: params.action,
        testId: params.testId ?? null,
        detail: params.detail ?? null,
        ip: params.ip ?? null,
      });
    } catch (error) {
      console.error('[audit] failed to persist audit entry', describe(error));
    }
    if (this.toConsole) {
      console.log(
        `[audit] actor=${params.actor} action=${params.action}` +
          (params.testId ? ` test=${params.testId}` : '') +
          (params.detail ? ` detail=${params.detail}` : ''),
      );
    }
  }

  /** Recipients are masked in anything that leaves the process. */
  mask(recipient: string): string {
    return maskRecipient(recipient);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
