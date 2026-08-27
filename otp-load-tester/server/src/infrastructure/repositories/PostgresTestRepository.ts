import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { errors } from '../../domain/errors.js';
import type {
  AuditEntry,
  AttemptStatus,
  LogEntry,
  LogLevel,
  OtpAttempt,
  SmsMode,
  TestSession,
  TestStatus,
} from '../../domain/types.js';
import type {
  ListSessionsOptions,
  ListSessionsResult,
  TestRepository,
} from './TestRepository.js';

const SCHEMA_PATH = fileURLToPath(new URL('../../../db/schema.sql', import.meta.url));

/** PostgreSQL adapter. Enable with PERSISTENCE=postgres and DATABASE_URL. */
export class PostgresTestRepository implements TestRepository {
  private readonly pool: Pool;

  constructor(connectionString: string, pool?: Pool) {
    this.pool = pool ?? new Pool({ connectionString, max: 10 });
  }

  /** Applies db/schema.sql (idempotent) so a fresh database is usable. */
  async migrate(): Promise<void> {
    const sql = await readFile(SCHEMA_PATH, 'utf8');
    await this.withClient((client) => client.query(sql));
  }

  async createSession(session: TestSession): Promise<TestSession> {
    await this.withClient((client) =>
      client.query(
        `INSERT INTO test_session (id, test_name, recipient, status, sms_mode, otp_length,
                                   rate_limit, max_messages, duration_seconds, generated, sent,
                                   failed, created_by, stop_reason, authorization_acknowledged,
                                   created_at, started_at, paused_at, stopped_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          session.id,
          session.testName,
          session.recipient,
          session.status,
          session.smsMode,
          session.otpLength,
          session.messagesPerMinute,
          session.maxMessages,
          session.durationSeconds,
          session.generated,
          session.sent,
          session.failed,
          session.createdBy,
          session.stopReason,
          session.authorizationAcknowledged,
          session.createdAt,
          session.startedAt,
          session.pausedAt,
          session.stoppedAt,
          session.completedAt,
        ],
      ),
    );
    return session;
  }

  async getSession(id: string): Promise<TestSession | null> {
    const result = await this.withClient((client) =>
      client.query('SELECT * FROM test_session WHERE id = $1', [id]),
    );
    const row = result.rows[0];
    return row ? mapSession(row) : null;
  }

  async updateSession(id: string, patch: Partial<TestSession>): Promise<TestSession> {
    const columns: Record<string, string> = {
      status: 'status',
      generated: 'generated',
      sent: 'sent',
      failed: 'failed',
      stopReason: 'stop_reason',
      startedAt: 'started_at',
      pausedAt: 'paused_at',
      stoppedAt: 'stopped_at',
      completedAt: 'completed_at',
      testName: 'test_name',
    };

    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length === 0) {
      const current = await this.getSession(id);
      if (!current) throw errors.notFound(id);
      return current;
    }
    values.push(id);
    const result = await this.withClient((client) =>
      client.query(
        `UPDATE test_session SET ${assignments.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values,
      ),
    );
    const row = result.rows[0];
    if (!row) throw errors.notFound(id);
    return mapSession(row);
  }

  async listSessions(options: ListSessionsOptions): Promise<ListSessionsResult> {
    const where = options.status ? 'WHERE status = $3' : '';
    const params: unknown[] = [options.limit, options.offset];
    if (options.status) params.push(options.status);
    const result = await this.withClient((client) =>
      client.query(
        `SELECT *, count(*) OVER () AS total_count FROM test_session ${where}
         ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        params,
      ),
    );
    const total = result.rows[0] ? Number(result.rows[0].total_count) : 0;
    return { items: result.rows.map(mapSession), total };
  }

  async deleteSession(id: string): Promise<boolean> {
    const result = await this.withClient((client) =>
      client.query('DELETE FROM test_session WHERE id = $1', [id]),
    );
    return (result.rowCount ?? 0) > 0;
  }

  async countSessionsByStatus(statuses: readonly TestStatus[]): Promise<number> {
    const result = await this.withClient((client) =>
      client.query(
        'SELECT count(*)::int AS count FROM test_session WHERE status = ANY($1::text[])',
        [[...statuses]],
      ),
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async createAttempt(attempt: OtpAttempt): Promise<void> {
    await this.withClient((client) =>
      client.query(
        `INSERT INTO otp_attempt (id, test_id, sequence, recipient, otp_hash, otp_plaintext, status,
                                  provider_message_id, error_message, latency_ms, created_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          attempt.id,
          attempt.testId,
          attempt.sequence,
          attempt.recipient,
          attempt.otpHash,
          attempt.otpPlaintext,
          attempt.status,
          attempt.providerMessageId,
          attempt.errorMessage,
          attempt.latencyMs,
          attempt.createdAt,
          attempt.completedAt,
        ],
      ),
    );
  }

  async updateAttempt(id: string, patch: Partial<OtpAttempt>): Promise<void> {
    const columns: Record<string, string> = {
      status: 'status',
      providerMessageId: 'provider_message_id',
      errorMessage: 'error_message',
      latencyMs: 'latency_ms',
      completedAt: 'completed_at',
    };
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length === 0) return;
    values.push(id);
    await this.withClient((client) =>
      client.query(
        `UPDATE otp_attempt SET ${assignments.join(', ')} WHERE id = $${values.length}`,
        values,
      ),
    );
  }

  async listAttempts(testId: string, limit: number): Promise<OtpAttempt[]> {
    const result = await this.withClient((client) =>
      client.query(
        'SELECT * FROM otp_attempt WHERE test_id = $1 ORDER BY sequence DESC LIMIT $2',
        [testId, limit],
      ),
    );
    return result.rows.map(mapAttempt).reverse();
  }

  async appendLog(entry: LogEntry): Promise<void> {
    await this.withClient((client) =>
      client.query(
        'INSERT INTO test_log (id, test_id, at, level, event, message) VALUES ($1,$2,$3,$4,$5,$6)',
        [entry.id, entry.testId, entry.at, entry.level, entry.event, entry.message],
      ),
    );
  }

  async listLogs(testId: string, limit: number): Promise<LogEntry[]> {
    const result = await this.withClient((client) =>
      client.query('SELECT * FROM test_log WHERE test_id = $1 ORDER BY at DESC, id DESC LIMIT $2', [
        testId,
        limit,
      ]),
    );
    return result.rows
      .map((row) => ({
        id: String(row.id),
        testId: String(row.test_id),
        at: toIso(row.at),
        level: row.level as LogLevel,
        event: String(row.event),
        message: String(row.message),
      }))
      .reverse();
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.withClient((client) =>
      client.query(
        'INSERT INTO audit_log (id, at, actor, action, test_id, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [entry.id, entry.at, entry.actor, entry.action, entry.testId, entry.detail, entry.ip],
      ),
    );
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    const result = await this.withClient((client) =>
      client.query('SELECT * FROM audit_log ORDER BY at DESC LIMIT $1', [limit]),
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      at: toIso(row.at),
      actor: String(row.actor),
      action: String(row.action),
      testId: row.test_id ? String(row.test_id) : null,
      detail: row.detail ? String(row.detail) : null,
      ip: row.ip ? String(row.ip) : null,
    }));
  }

  async reconcileInterruptedSessions(): Promise<string[]> {
    const result = await this.withClient((client) =>
      client.query(
        `UPDATE test_session
            SET status = 'FAILED',
                stop_reason = COALESCE(stop_reason, 'SERVER_SHUTDOWN'),
                stopped_at = COALESCE(stopped_at, now())
          WHERE status IN ('RUNNING', 'PAUSED', 'STOPPING')
        RETURNING id`,
      ),
    );
    return result.rows.map((row) => String(row.id));
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw errors.storage(
        `Database unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return await fn(client);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        throw errors.storage(
          `Database error ${(error as { code?: string }).code}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapSession(row: Record<string, unknown>): TestSession {
  return {
    id: String(row.id),
    testName: row.test_name === null ? null : String(row.test_name),
    recipient: String(row.recipient),
    status: row.status as TestStatus,
    smsMode: row.sms_mode as SmsMode,
    otpLength: Number(row.otp_length),
    messagesPerMinute: Number(row.rate_limit),
    maxMessages: Number(row.max_messages),
    durationSeconds: Number(row.duration_seconds),
    generated: Number(row.generated),
    sent: Number(row.sent),
    failed: Number(row.failed),
    createdBy: String(row.created_by),
    stopReason: (row.stop_reason ?? null) as TestSession['stopReason'],
    authorizationAcknowledged: true,
    createdAt: toIso(row.created_at),
    startedAt: optIso(row.started_at),
    pausedAt: optIso(row.paused_at),
    stoppedAt: optIso(row.stopped_at),
    completedAt: optIso(row.completed_at),
  };
}

function mapAttempt(row: Record<string, unknown>): OtpAttempt {
  return {
    id: String(row.id),
    testId: String(row.test_id),
    sequence: Number(row.sequence),
    recipient: String(row.recipient),
    otpHash: String(row.otp_hash),
    otpPlaintext: row.otp_plaintext === null ? null : String(row.otp_plaintext),
    status: row.status as AttemptStatus,
    providerMessageId: row.provider_message_id === null ? null : String(row.provider_message_id),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    createdAt: toIso(row.created_at),
    completedAt: optIso(row.completed_at),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function optIso(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}
