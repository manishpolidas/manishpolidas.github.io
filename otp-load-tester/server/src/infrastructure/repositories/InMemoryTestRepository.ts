import { errors } from '../../domain/errors.js';
import type {
  AuditEntry,
  LogEntry,
  OtpAttempt,
  TestSession,
  TestStatus,
} from '../../domain/types.js';
import { nowIso } from '../../services/time.js';
import type {
  ListSessionsOptions,
  ListSessionsResult,
  TestRepository,
} from './TestRepository.js';

interface Options {
  /** Maximum activity log entries retained per test. */
  maxLogsPerTest?: number;
  maxAuditEntries?: number;
}

/** Default adapter: no external dependency, data lives for the process lifetime. */
export class InMemoryTestRepository implements TestRepository {
  private readonly sessions = new Map<string, TestSession>();
  private readonly attempts = new Map<string, OtpAttempt[]>();
  private readonly logs = new Map<string, LogEntry[]>();
  private readonly audit: AuditEntry[] = [];
  private readonly maxLogsPerTest: number;
  private readonly maxAuditEntries: number;

  constructor(options: Options = {}) {
    this.maxLogsPerTest = options.maxLogsPerTest ?? 5_000;
    this.maxAuditEntries = options.maxAuditEntries ?? 5_000;
  }

  async createSession(session: TestSession): Promise<TestSession> {
    this.sessions.set(session.id, { ...session });
    this.attempts.set(session.id, []);
    this.logs.set(session.id, []);
    return { ...session };
  }

  async getSession(id: string): Promise<TestSession | null> {
    const found = this.sessions.get(id);
    return found ? { ...found } : null;
  }

  async updateSession(id: string, patch: Partial<TestSession>): Promise<TestSession> {
    const current = this.sessions.get(id);
    if (!current) throw errors.notFound(id);
    const updated: TestSession = { ...current, ...patch, id: current.id };
    this.sessions.set(id, updated);
    return { ...updated };
  }

  async listSessions(options: ListSessionsOptions): Promise<ListSessionsResult> {
    const all = [...this.sessions.values()]
      .filter((session) => !options.status || session.status === options.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      items: all.slice(options.offset, options.offset + options.limit).map((s) => ({ ...s })),
      total: all.length,
    };
  }

  async deleteSession(id: string): Promise<boolean> {
    this.attempts.delete(id);
    this.logs.delete(id);
    return this.sessions.delete(id);
  }

  async countSessionsByStatus(statuses: readonly TestStatus[]): Promise<number> {
    return [...this.sessions.values()].filter((session) => statuses.includes(session.status)).length;
  }

  async createAttempt(attempt: OtpAttempt): Promise<void> {
    const list = this.attempts.get(attempt.testId) ?? [];
    list.push({ ...attempt });
    this.attempts.set(attempt.testId, list);
  }

  async updateAttempt(id: string, patch: Partial<OtpAttempt>): Promise<void> {
    for (const list of this.attempts.values()) {
      const index = list.findIndex((attempt) => attempt.id === id);
      if (index >= 0) {
        list[index] = { ...(list[index] as OtpAttempt), ...patch };
        return;
      }
    }
  }

  async listAttempts(testId: string, limit: number): Promise<OtpAttempt[]> {
    const list = this.attempts.get(testId) ?? [];
    return list.slice(-limit).map((attempt) => ({ ...attempt }));
  }

  async appendLog(entry: LogEntry): Promise<void> {
    const list = this.logs.get(entry.testId) ?? [];
    list.push({ ...entry });
    if (list.length > this.maxLogsPerTest) list.splice(0, list.length - this.maxLogsPerTest);
    this.logs.set(entry.testId, list);
  }

  async listLogs(testId: string, limit: number): Promise<LogEntry[]> {
    const list = this.logs.get(testId) ?? [];
    return list.slice(-limit).map((entry) => ({ ...entry }));
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.audit.push({ ...entry });
    if (this.audit.length > this.maxAuditEntries) {
      this.audit.splice(0, this.audit.length - this.maxAuditEntries);
    }
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    return this.audit.slice(-limit).map((entry) => ({ ...entry }));
  }

  async reconcileInterruptedSessions(): Promise<string[]> {
    const interrupted: string[] = [];
    for (const [id, session] of this.sessions) {
      if (
        session.status === 'RUNNING' ||
        session.status === 'PAUSED' ||
        session.status === 'STOPPING'
      ) {
        this.sessions.set(id, {
          ...session,
          status: 'FAILED',
          stopReason: 'SERVER_SHUTDOWN',
          stoppedAt: session.stoppedAt ?? nowIso(),
        });
        interrupted.push(id);
      }
    }
    return interrupted;
  }
}
