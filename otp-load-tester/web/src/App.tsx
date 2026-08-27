import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityLog } from './components/ActivityLog';
import { HistoryPanel } from './components/HistoryPanel';
import { LoginView } from './components/LoginView';
import { SafetyBanner } from './components/SafetyBanner';
import { StatsPanel } from './components/StatsPanel';
import { TestDetail, type TestDetailData } from './components/TestDetail';
import { TestForm } from './components/TestForm';
import { ApiError, api, type CreateTestInput } from './lib/api';
import { useRealtime } from './lib/useRealtime';
import type {
  LogEntry,
  PlatformConfig,
  Session,
  TestEnvelope,
  TestSession,
  TestSnapshot,
} from './lib/types';
import { isLive } from './lib/types';

const MAX_LOG_ENTRIES = 1000;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [current, setCurrent] = useState<TestEnvelope | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [history, setHistory] = useState<TestSession[]>([]);
  const [detail, setDetail] = useState<TestDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = current?.test.id ?? null;

  const refreshHistory = useCallback(async () => {
    try {
      const result = await api.listTests(25, 0);
      setHistory(result.items);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  // Session bootstrap.
  useEffect(() => {
    void (async () => {
      try {
        setSession(await api.session());
      } catch {
        setSession(null);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  // Load config + history once signed in.
  useEffect(() => {
    if (!session) return;
    void (async () => {
      try {
        setConfig(await api.config());
        await refreshHistory();
      } catch (cause) {
        setError(messageOf(cause));
      }
    })();
  }, [session, refreshHistory]);

  // Repaint the elapsed-time counter every second while a test is live.
  useEffect(() => {
    if (!isLive(current?.snapshot.status)) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [current?.snapshot.status]);

  const connection = useRealtime(session !== null, (event) => {
    switch (event.type) {
      case 'test.update':
      case 'test.created':
      case 'test.finished': {
        const snapshot: TestSnapshot = event.payload;
        if (snapshot.testId !== currentIdRef.current) return;
        setCurrent((previous) =>
          previous
            ? {
                snapshot,
                test: { ...previous.test, ...sessionPatchFrom(snapshot) },
              }
            : previous,
        );
        if (event.type === 'test.finished') void refreshHistory();
        return;
      }
      case 'test.log': {
        if (event.payload.testId !== currentIdRef.current) return;
        setLogs((previous) => {
          const next = [...previous, event.payload];
          return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
        });
        return;
      }
      case 'test.deleted': {
        if (event.payload.testId === currentIdRef.current) {
          setCurrent(null);
          setLogs([]);
        }
        void refreshHistory();
        return;
      }
      default:
        return;
    }
  });

  const run = async (name: string, action: () => Promise<void>): Promise<void> => {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(messageOf(cause));
      if (cause instanceof ApiError && cause.status === 401) setSession(null);
    } finally {
      setBusy(null);
    }
  };

  const handleLogin = async (username: string, password: string): Promise<void> => {
    setLoginError(null);
    try {
      setSession(await api.login(username, password));
    } catch (cause) {
      setLoginError(messageOf(cause));
    }
  };

  const handleStart = (input: CreateTestInput): void => {
    void run('start', async () => {
      // Create then start: the configuration is persisted before any OTP exists.
      const created = await api.createTest(input);
      setLogs([]);
      setCurrent(created);
      currentIdRef.current = created.test.id;
      const started = await api.startTest(created.test.id);
      setCurrent(started);
      await refreshHistory();
    });
  };

  const withCurrent = (name: string, action: (testId: string) => Promise<TestEnvelope>) => () => {
    const testId = current?.test.id;
    if (!testId) return;
    void run(name, async () => {
      setCurrent(await action(testId));
      await refreshHistory();
      // Reconcile the log tail with the server after a state change.
      const { items } = await api.logs(testId, MAX_LOG_ENTRIES);
      setLogs(items);
    });
  };

  const handleOpenDetail = (testId: string): void => {
    void run('detail', async () => {
      const [{ test }, logsResult, attemptsResult] = await Promise.all([
        api.getTest(testId),
        api.logs(testId, 1000),
        api.attempts(testId, 1000),
      ]);
      setDetail({ test, logs: logsResult.items, attempts: attemptsResult.items });
    });
  };

  const handleDelete = (testId: string): void => {
    void run('delete', async () => {
      await api.deleteTest(testId);
      if (currentIdRef.current === testId) {
        setCurrent(null);
        setLogs([]);
      }
      await refreshHistory();
    });
  };

  if (booting) return <div className="login-shell">Loading…</div>;
  if (!session) return <LoginView onSubmit={handleLogin} error={loginError} />;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>OTP Test Console</h1>
          <p className="muted">Controlled OTP generation and load testing for systems you own.</p>
        </div>
        <div className="header-actions">
          <span className="muted" data-testid="current-user">
            {session.username} ({session.role})
          </span>
          <button
            type="button"
            className="danger"
            onClick={() =>
              void run('stop-all', async () => {
                await api.stopAll();
                if (current) setCurrent(await api.getTest(current.test.id));
                await refreshHistory();
              })
            }
            disabled={session.role !== 'admin' || busy !== null}
            data-testid="btn-emergency-stop"
          >
            Emergency stop
          </button>
          <button
            type="button"
            onClick={() =>
              void run('logout', async () => {
                await api.logout();
                setSession(null);
                setCurrent(null);
                setLogs([]);
              })
            }
          >
            Sign out
          </button>
        </div>
      </header>

      {config ? <SafetyBanner config={config} /> : null}

      {error ? (
        <div className="error banner-error" role="alert" data-testid="error-banner">
          {error}
          <button type="button" className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      ) : null}

      <main className="layout">
        <section className="column">
          {config ? (
            <TestForm
              config={config}
              status={current?.snapshot.status ?? null}
              busy={busy}
              canExecute={session.role === 'admin'}
              onStart={handleStart}
              onStop={withCurrent('stop', (testId) => api.stopTest(testId))}
              onPause={withCurrent('pause', (testId) => api.pauseTest(testId))}
              onResume={withCurrent('resume', (testId) => api.resumeTest(testId))}
              onReset={() => {
                setCurrent(null);
                setLogs([]);
                setError(null);
              }}
            />
          ) : null}
        </section>

        <section className="column">
          <StatsPanel snapshot={current?.snapshot ?? null} connection={connection} />
          <ActivityLog entries={logs} />
        </section>
      </main>

      <HistoryPanel
        items={history}
        onOpen={handleOpenDetail}
        onDelete={handleDelete}
        canExecute={session.role === 'admin'}
        activeTestId={current?.test.id ?? null}
      />

      {detail ? <TestDetail data={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}

/** Keeps the cached session row in step with an incoming snapshot. */
function sessionPatchFrom(snapshot: TestSnapshot): Partial<TestSession> {
  return {
    status: snapshot.status,
    generated: snapshot.generated,
    sent: snapshot.sent,
    failed: snapshot.failed,
    startedAt: snapshot.startedAt,
    stoppedAt: snapshot.stoppedAt,
    completedAt: snapshot.completedAt,
    stopReason: snapshot.stopReason,
  };
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError) {
    const details = cause.details?.map((detail) => `${detail.field}: ${detail.message}`).join('; ');
    return details ? `${cause.message} (${details})` : cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
