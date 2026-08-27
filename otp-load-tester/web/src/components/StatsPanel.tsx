import type { TestSnapshot } from '../lib/types';
import { formatClock, formatDuration } from '../lib/format';

export function StatsPanel({
  snapshot,
  connection,
}: {
  snapshot: TestSnapshot | null;
  connection: string;
}) {
  if (!snapshot) {
    return (
      <div className="card" data-testid="stats-panel">
        <h2>Live statistics</h2>
        <p className="muted" data-testid="stats-empty">
          No test loaded. Configure a test and press Start Test.
        </p>
      </div>
    );
  }

  const liveElapsed =
    snapshot.status === 'RUNNING' && snapshot.startedAt
      ? Date.now() - Date.parse(snapshot.startedAt)
      : snapshot.elapsedMs;

  return (
    <div className="card" data-testid="stats-panel">
      <div className="card-header">
        <h2>Live statistics</h2>
        <span className={`pill pill-${connection}`} title={`realtime feed: ${connection}`}>
          {connection}
        </span>
      </div>

      <div className="status-row">
        <span className={`status status-${snapshot.status.toLowerCase()}`} data-testid="test-status">
          {snapshot.status}
        </span>
        <code data-testid="test-id">{snapshot.testId}</code>
        {snapshot.testName ? <span className="muted">{snapshot.testName}</span> : null}
      </div>

      <dl className="stats">
        <Stat label="Recipient" value={snapshot.recipient} testId="stat-recipient" />
        <Stat label="Messages generated" value={snapshot.generated} testId="stat-generated" />
        <Stat label="Messages sent" value={snapshot.sent} testId="stat-sent" />
        <Stat label="Failures" value={snapshot.failed} testId="stat-failed" />
        <Stat
          label="Configured rate"
          value={`${snapshot.configuredRatePerMinute}/minute`}
          testId="stat-rate"
        />
        <Stat
          label="Observed rate"
          value={`${snapshot.observedRatePerMinute}/minute`}
          testId="stat-observed-rate"
        />
        <Stat label="Start time" value={formatClock(snapshot.startedAt)} testId="stat-start" />
        <Stat label="Elapsed" value={formatDuration(liveElapsed)} testId="stat-elapsed" />
        <Stat
          label="Remaining messages"
          value={snapshot.remainingMessages}
          testId="stat-remaining"
        />
        <Stat
          label="Remaining time"
          value={formatDuration(snapshot.remainingMs)}
          testId="stat-remaining-time"
        />
        <Stat label="OTP length" value={`${snapshot.otpLength} digits`} testId="stat-otp-length" />
        <Stat label="Provider mode" value={snapshot.smsMode} testId="stat-mode" />
      </dl>

      {snapshot.stopReason ? (
        <p className="muted" data-testid="stop-reason">
          Finished: {snapshot.stopReason.replace(/_/g, ' ').toLowerCase()} at{' '}
          {formatClock(snapshot.stoppedAt ?? snapshot.completedAt)}
        </p>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  testId,
}: {
  label: string;
  value: string | number;
  testId: string;
}) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}
