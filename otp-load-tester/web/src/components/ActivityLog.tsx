import { useEffect, useRef } from 'react';
import type { LogEntry } from '../lib/types';
import { formatClock } from '../lib/format';

export function ActivityLog({ entries }: { entries: LogEntry[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length]);

  return (
    <div className="card log-card" data-testid="activity-log">
      <div className="card-header">
        <h2>Activity log</h2>
        <span className="muted">{entries.length} entries</span>
      </div>
      <div className="log-scroll">
        {entries.length === 0 ? (
          <p className="muted">Activity appears here in real time once a test starts.</p>
        ) : (
          <table className="log-table">
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className={`log-${entry.level}`} data-testid="log-row">
                  <td className="log-time">{formatClock(entry.at)}</td>
                  <td className="log-event">{entry.event}</td>
                  <td className="log-message">{entry.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
