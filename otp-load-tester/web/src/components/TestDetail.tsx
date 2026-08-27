import type { LogEntry, OtpAttempt, TestSession } from '../lib/types';
import { durationBetween, formatClock, formatDateTime } from '../lib/format';

export interface TestDetailData {
  test: TestSession;
  logs: LogEntry[];
  attempts: OtpAttempt[];
}

export function TestDetail({ data, onClose }: { data: TestDetailData; onClose: () => void }) {
  const { test, logs, attempts } = data;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" data-testid="test-detail">
      <div className="modal card">
        <div className="card-header">
          <h2>{test.testName ?? test.id}</h2>
          <button type="button" className="link" onClick={onClose} data-testid="btn-close-detail">
            Close
          </button>
        </div>

        <dl className="stats">
          <Row label="Test ID" value={test.id} />
          <Row label="Recipient" value={test.recipient} />
          <Row label="Final status" value={test.status} />
          <Row label="Stop reason" value={test.stopReason ?? '-'} />
          <Row label="Configured rate" value={`${test.messagesPerMinute}/minute`} />
          <Row label="OTP length" value={`${test.otpLength} digits`} />
          <Row label="Generated" value={String(test.generated)} />
          <Row label="Successful" value={String(test.sent)} />
          <Row label="Failed" value={String(test.failed)} />
          <Row label="Started" value={formatDateTime(test.startedAt)} />
          <Row label="Ended" value={formatDateTime(test.stoppedAt ?? test.completedAt)} />
          <Row
            label="Duration"
            value={durationBetween(test.startedAt, test.stoppedAt ?? test.completedAt)}
          />
          <Row label="Started by" value={test.createdBy} />
          <Row label="Provider mode" value={test.smsMode} />
        </dl>

        <h3>Attempts ({attempts.length})</h3>
        <div className="table-scroll short">
          <table className="history-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Status</th>
                <th>OTP</th>
                <th>Message ID</th>
                <th>Latency</th>
                <th>Created</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => (
                <tr key={attempt.id}>
                  <td>{attempt.sequence}</td>
                  <td>{attempt.status}</td>
                  <td>
                    <code>{attempt.otpPlaintext ?? `${attempt.otpHash.slice(0, 10)}…`}</code>
                  </td>
                  <td>{attempt.providerMessageId ?? '-'}</td>
                  <td>{attempt.latencyMs === null ? '-' : `${attempt.latencyMs}ms`}</td>
                  <td>{formatClock(attempt.createdAt)}</td>
                  <td className="log-message">{attempt.errorMessage ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>Log ({logs.length})</h3>
        <div className="table-scroll short">
          <table className="log-table">
            <tbody>
              {logs.map((entry) => (
                <tr key={entry.id} className={`log-${entry.level}`}>
                  <td className="log-time">{formatClock(entry.at)}</td>
                  <td className="log-event">{entry.event}</td>
                  <td className="log-message">{entry.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
