import type { TestSession } from '../lib/types';
import { durationBetween, formatDateTime } from '../lib/format';

export function HistoryPanel({
  items,
  onOpen,
  onDelete,
  canExecute,
  activeTestId,
}: {
  items: TestSession[];
  onOpen: (testId: string) => void;
  onDelete: (testId: string) => void;
  canExecute: boolean;
  activeTestId: string | null;
}) {
  return (
    <div className="card" data-testid="history-panel">
      <div className="card-header">
        <h2>Test history</h2>
        <span className="muted">{items.length} tests</span>
      </div>
      {items.length === 0 ? (
        <p className="muted">Completed tests are listed here.</p>
      ) : (
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Test</th>
                <th>Recipient</th>
                <th>Status</th>
                <th>Rate</th>
                <th>Generated</th>
                <th>Sent</th>
                <th>Failed</th>
                <th>Started</th>
                <th>Duration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className={item.id === activeTestId ? 'row-active' : undefined}
                  data-testid="history-row"
                >
                  <td>
                    <button className="link" type="button" onClick={() => onOpen(item.id)}>
                      {item.testName ?? item.id}
                    </button>
                    <div className="muted small">{item.id}</div>
                  </td>
                  <td>{item.recipient}</td>
                  <td>
                    <span className={`status status-${item.status.toLowerCase()}`}>
                      {item.status}
                    </span>
                  </td>
                  <td>{item.messagesPerMinute}/min</td>
                  <td>{item.generated}</td>
                  <td>{item.sent}</td>
                  <td>{item.failed}</td>
                  <td>{formatDateTime(item.startedAt)}</td>
                  <td>{durationBetween(item.startedAt, item.stoppedAt ?? item.completedAt)}</td>
                  <td>
                    <button
                      className="link danger-link"
                      type="button"
                      onClick={() => onDelete(item.id)}
                      disabled={!canExecute}
                      data-testid="btn-delete"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
