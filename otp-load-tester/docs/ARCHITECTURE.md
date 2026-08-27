# Architecture

## 1. Shape of the system

```
Browser - React + TypeScript dashboard (web/)
  TestForm | StatsPanel | ActivityLog | HistoryPanel | TestDetail
        |                                    |
        | REST (fetch, cookie session)       | WebSocket /ws
        v                                    v
API layer (server/src/api)
  routes: auth | tests | system
  middleware: auth/CSRF, rate limit, error handler
  ws/wsServer.ts (authenticated upgrade)
        |
        | plain method calls - no HTTP types below this line
        v
Application layer (server/src/services)
  TestService     lifecycle, concurrency, authorization, audit
  TestRunner      the scheduler: pacing, stop conditions, cancellation
  OtpService      cryptographically secure OTP generation + hashing
  LoggingService  activity log + append-only audit trail
  EventBus        fan-out of snapshots/log lines to the WebSocket
        |                                    |
        | ports (interfaces)                 |
        v                                    v
SmsProvider                            TestRepository
  MockSmsProvider (default)              InMemoryTestRepository (default)
  SandboxSmsProvider                     PostgresTestRepository
  AuthorizedSmsProvider
```

`server/src/container.ts` is the single composition root; it is the only module
that knows which concrete adapters are in use. `server/src/domain` has no
imports from any outer layer, so the business rules are unit-testable without a
server, a database or a provider.

## 2. Folder structure

```
otp-load-tester/
├── package.json                 npm workspaces: server, web
├── docker-compose.yml           postgres + api + web
├── .env.example                 every setting, documented
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── STOP_MECHANISM.md
│   └── SECURITY.md
├── server/
│   ├── Dockerfile
│   ├── db/schema.sql
│   ├── vitest.config.ts
│   └── src/
│       ├── index.ts                     process bootstrap + graceful shutdown
│       ├── app.ts                       Express app factory (no listen)
│       ├── container.ts                 composition root
│       ├── config.ts                    env parsing + validation (fails fast)
│       ├── domain/
│       │   ├── types.ts                 TestSession, OtpAttempt, LogEntry, ...
│       │   ├── errors.ts                AppError + error-code catalogue
│       │   ├── limits.ts                DEFAULT_LIMITS, HARD_CAPS, clamping
│       │   └── validation.ts            zod schemas, recipient + allowlist rules
│       ├── services/
│       │   ├── otpService.ts            crypto.randomInt OTPs, HMAC hashing
│       │   ├── scheduler.ts             TestRunner - pacing and cancellation
│       │   ├── testService.ts           lifecycle, registry, audit, limits
│       │   ├── loggingService.ts        activity log + audit trail
│       │   ├── snapshot.ts              session row -> dashboard view
│       │   ├── eventBus.ts              in-process pub/sub
│       │   └── time.ts                  abortable delay, CancelledError
│       ├── infrastructure/
│       │   ├── sms/                     SmsProvider + mock/sandbox/authorized
│       │   ├── repositories/            TestRepository + memory/postgres
│       │   └── security/                scrypt passwords, signed sessions
│       ├── api/
│       │   ├── routes/{auth,tests,system}.ts
│       │   ├── middleware/{auth,rateLimit,errorHandler,asyncHandler}.ts
│       │   └── ws/wsServer.ts
│       ├── scripts/hashPassword.ts
│       └── tests/                       Vitest suites + shared helpers
└── web/
    ├── Dockerfile, nginx.conf
    ├── vite.config.ts                   dev proxy for /api and /ws
    ├── playwright.config.ts             boots API + dashboard for e2e
    ├── e2e/dashboard.spec.ts
    └── src/
        ├── main.tsx, App.tsx, styles.css
        ├── components/                  form, stats, log, history, detail, login
        └── lib/                         api client, realtime hook, formatting, types
```

## 3. Request flow: pressing "Start Test"

1. `TestForm` validates locally (recipient shape, numeric ranges, authorization
   checkbox) and calls `POST /api/tests`.
2. `createTestsRouter` authenticates the session cookie, checks the CSRF header
   and the `admin` role, then hands the raw body to `TestService.createTest`.
3. `TestService` parses it with the zod schema built from the **current** safety
   limits, enforces the recipient allowlist for non-mock modes, persists a
   `CREATED` session and writes an audit entry.
4. The dashboard calls `POST /api/tests/{id}/start`. `TestService` re-checks the
   status, the concurrency limit and the limits (they may have tightened), then
   constructs a `TestRunner` and calls `start()`.
5. `TestRunner` marks the session `RUNNING`, arms the duration watchdog and
   enters its loop:
   *check abort -> check caps -> wait for the next slot -> generate OTP ->
   persist a `PENDING` attempt -> send via the provider -> record `SENT`/`FAILED`
   -> repeat.*
6. Every persisted change publishes a snapshot on the `EventBus`; every activity
   line publishes a log frame. `wsServer` forwards both to authenticated
   dashboards, which update without polling.
7. The run ends on Stop, the message cap, duration expiry, the watchdog, or a
   fatal error; the terminal status, `stopReason` and timestamps are persisted
   and a `test.finished` frame is emitted.

## 4. Rate control

* Configured rate: `intervalMs = 60_000 / messagesPerMinute`.
* The loop tracks the next scheduled slot and advances it by `intervalMs`
  (drift correction) but never bursts to catch up after a slow send -
  `nextDispatchAt = max(nextDispatchAt + intervalMs, now)`.
* Exactly one send is in flight at a time. If provider latency exceeds the
  interval, the observed rate degrades and a `rate.degraded` warning is logged
  once; the platform never compensates by sending faster than configured.
* The dashboard shows configured *and* observed rate, so degradation is visible.

## 5. Database schema

`server/db/schema.sql` (applied automatically at startup when
`PERSISTENCE=postgres`).

**test_session** - one row per test
`id`, `test_name`, `recipient`, `status`, `sms_mode`, `otp_length`,
`rate_limit` (messages/minute), `max_messages`, `duration_seconds`,
`generated`, `sent`, `failed`, `created_by`, `stop_reason`,
`authorization_acknowledged`, `created_at`, `started_at`, `paused_at`,
`stopped_at`, `completed_at`.
Status is constrained to `CREATED | RUNNING | PAUSED | STOPPING | STOPPED |
COMPLETED | FAILED`.

**otp_attempt** - one row per generated OTP
`id`, `test_id` (FK, cascade), `sequence` (unique per test), `recipient`,
`otp_hash` (HMAC-SHA256 with the server pepper), `otp_plaintext`
(**mock mode only**, otherwise `NULL`), `status`
(`PENDING | SENT | FAILED | CANCELLED`), `provider_message_id`,
`error_message`, `latency_ms`, `created_at`, `completed_at`.

**test_log** - activity log lines (`level`, `event`, `message`) per test.

**audit_log** - append-only: `actor`, `action`, `test_id`, `detail`, `ip`.

The in-memory adapter implements the same port with bounded per-test log
retention, which is why the default configuration needs no database at all.

## 6. Status model

```
CREATED --start--> RUNNING --pause--> PAUSED --resume--> RUNNING
                     |                  |
                     +------ stop ------+--> STOPPING --> STOPPED

RUNNING --max messages / duration / watchdog--> COMPLETED
RUNNING --fatal error--> FAILED
```

`STOPPED`, `COMPLETED` and `FAILED` are terminal: a finished test can never be
restarted, only re-created. `STOPPING` is the short window in which the abort
has been issued and the last in-flight send is unwinding.

Sessions left `RUNNING`/`PAUSED`/`STOPPING` by a crash are closed out as
`FAILED` at startup (`reconcileInterruptedSessions`) because scheduled work
never survives a restart.
