import type {
  AuditEntry,
  LogEntry,
  OtpAttempt,
  TestSession,
  TestStatus,
} from '../../domain/types.js';

export interface ListSessionsOptions {
  limit: number;
  offset: number;
  status?: TestStatus;
}

export interface ListSessionsResult {
  items: TestSession[];
  total: number;
}

/**
 * Persistence port. Two adapters ship with the project: an in-memory store
 * (default, zero setup) and PostgreSQL.
 */
export interface TestRepository {
  createSession(session: TestSession): Promise<TestSession>;
  getSession(id: string): Promise<TestSession | null>;
  updateSession(id: string, patch: Partial<TestSession>): Promise<TestSession>;
  listSessions(options: ListSessionsOptions): Promise<ListSessionsResult>;
  deleteSession(id: string): Promise<boolean>;
  countSessionsByStatus(statuses: readonly TestStatus[]): Promise<number>;

  createAttempt(attempt: OtpAttempt): Promise<void>;
  updateAttempt(id: string, patch: Partial<OtpAttempt>): Promise<void>;
  listAttempts(testId: string, limit: number): Promise<OtpAttempt[]>;

  appendLog(entry: LogEntry): Promise<void>;
  listLogs(testId: string, limit: number): Promise<LogEntry[]>;

  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(limit: number): Promise<AuditEntry[]>;

  /**
   * Called at startup: any session still marked RUNNING/PAUSED/STOPPING is the
   * residue of a crash or restart and can never be resumed, so it is closed out
   * as FAILED.
   */
  reconcileInterruptedSessions(): Promise<string[]>;

  dispose?(): Promise<void>;
}
