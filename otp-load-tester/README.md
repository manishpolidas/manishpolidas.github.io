# OTP Testing & Load-Testing Platform

A dashboard and API for running **controlled OTP generation tests** against an
authentication system **you own or are explicitly authorized to test**.

Enter a test recipient, configure the rate/volume/duration, press **Start Test**,
and watch generated OTPs, delivery results and live statistics stream into the
dashboard. Press **Stop** and the run halts immediately - see
[docs/STOP_MECHANISM.md](docs/STOP_MECHANISM.md) for exactly why no further
request can be created after that point.

> **Default mode is LOCAL MOCK MODE.** Out of the box every OTP is delivered to
> an in-process simulator: no SMS is sent, no network call is made, nothing
> leaves the machine. Sandbox and authorized-delivery modes exist, are off by
> default, and refuse to start without a recipient allowlist. The platform
> contains no facility for evading provider rate limits, CAPTCHA or anti-abuse
> controls, and is not usable for messaging recipients you have not allowlisted.

---

## Contents

| Document | What is in it |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering, folder structure, data flow, database schema |
| [docs/API.md](docs/API.md) | Every endpoint with request/response examples |
| [docs/STOP_MECHANISM.md](docs/STOP_MECHANISM.md) | How Stop guarantees no new requests are created |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth, CSRF, rate limits, safety controls, threat notes |

---

## Quick start (local mock mode, no database)

Requires Node.js 20.12+ (22 recommended).

```bash
cd otp-load-tester
npm install                     # installs the server and web workspaces

cp .env.example .env            # defaults are already safe: SMS_MODE=mock
# The example file ships a development login: admin / admin123

npm run dev                     # API on :4000, dashboard on :5173
```

Open <http://localhost:5173>, sign in with `admin` / `admin123`, tick
*"I confirm that I am authorized to test this recipient/system"*, and start a
test with e.g. recipient `TEST-USER-001`, 10 messages/minute, max 50 messages,
300 second duration.

To run the two processes separately:

```bash
npm run dev --workspace=server   # tsx watch, API on :4000
npm run dev --workspace=web      # Vite dev server on :5173 (proxies /api and /ws)
```

### Setting a real dashboard password

`DASHBOARD_PASSWORD` (plaintext) works in development only and is rejected when
`NODE_ENV=production`. Generate a scrypt hash instead:

```bash
npm run hash-password -- 'a long dashboard password'
# -> DASHBOARD_PASSWORD_HASH=scrypt$<salt>$<hash>
```

---

## Commands

| Command | Description |
| --- | --- |
| `npm install` | Install both workspaces |
| `npm run dev` | Run API + dashboard together (development) |
| `npm run build` | Type-check and build server (`tsc`) and web (`vite build`) |
| `npm test` | Server unit + integration tests (Vitest) |
| `npm run test:e2e` | Playwright UI tests (boots API + dashboard automatically) |
| `npm run typecheck` | `tsc --noEmit` in both workspaces |
| `npm run hash-password -- '<pw>'` | Generate `DASHBOARD_PASSWORD_HASH` |
| `npm start --workspace=server` | Run the compiled server (`dist/index.js`) |

### Tests

```bash
npm test                        # OTP service, scheduler, stop semantics, API, realtime
npm run test:e2e                # dashboard: start/stop/pause/resume/reset/validation
```

The Vitest suite covers OTP generation (length, digits, randomness, hashing),
the scheduler (interval pacing, message cap, duration expiry, pause/resume,
failure accounting), the stop mechanism (idempotency, in-flight cancellation, no
post-stop activity, restart refusal, concurrency limit, shutdown), every REST
endpoint (auth, CSRF, roles, validation, state-transition errors, rate limiting)
and the WebSocket feed.

---

## Docker

```bash
cd otp-load-tester
cp .env.example .env
# docker-compose requires these to be set explicitly:
#   SESSION_SECRET, OTP_HASH_PEPPER, DASHBOARD_PASSWORD_HASH
docker compose up --build
```

* dashboard: <http://localhost:8080> (nginx serves the SPA and proxies `/api`, `/ws`)
* API: internal on `api:4000`
* PostgreSQL 16 with the schema applied automatically on API startup

---

## Configuration

Full list with comments in [`.env.example`](.env.example). The important ones:

| Variable | Default | Notes |
| --- | --- | --- |
| `SMS_MODE` | `mock` | `mock` \| `sandbox` \| `authorized` |
| `RECIPIENT_ALLOWLIST` | *(empty)* | **Required** for sandbox/authorized modes |
| `MAX_MESSAGES_PER_MINUTE` | `60` | Hard cap 600 |
| `MAX_MESSAGES_PER_TEST` | `500` | Hard cap 5000 |
| `MAX_DURATION_SECONDS` | `900` | Hard cap 3600 |
| `MAX_CONCURRENT_TESTS` | `3` | Hard cap 10 |
| `API_RATE_LIMIT_PER_MINUTE` | `120` | Per session/IP API limiter |
| `STORE_PLAINTEXT_OTP` | `true` | Forced to `false` outside mock mode |
| `PERSISTENCE` | `memory` | `memory` \| `postgres` (`DATABASE_URL` required) |
| `SESSION_SECRET`, `OTP_HASH_PEPPER` | dev values | Must be set in production |

The hard caps in `server/src/domain/limits.ts` are compiled in: operator
configuration is clamped to them and cannot exceed them.

---

## Provider modes

```
SmsProvider (interface: sendOtp(recipient, otp, ctx))
├── MockSmsProvider        local simulator - latency, failure injection, history
└── HttpSmsProvider
    ├── SandboxSmsProvider vendor sandbox endpoint (no real delivery)
    └── AuthorizedSmsProvider real delivery, allowlisted recipients only
```

Swapping providers is configuration, not code: `createSmsProvider(config)` is the
only place that knows which concrete class is in play.

---

## Project layout

```
otp-load-tester/
├── docker-compose.yml          postgres + api + web
├── .env.example
├── docs/                       architecture, API, stop mechanism, security
├── server/                     Node + TypeScript + Express + ws
│   ├── db/schema.sql           PostgreSQL schema
│   └── src/
│       ├── domain/             types, errors, limits, validation (no I/O)
│       ├── services/           OTP service, scheduler, test service, logging
│       ├── infrastructure/     SMS providers, repositories, security primitives
│       ├── api/                routes, middleware, WebSocket server
│       ├── app.ts container.ts index.ts
│       └── tests/              Vitest suites
└── web/                        React + TypeScript + Vite dashboard
    ├── src/components/         form, stats, activity log, history, detail
    ├── src/lib/                API client, realtime hook, formatting
    └── e2e/                    Playwright specs
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full breakdown.

---

## Authorized use

This project is intended for engineers validating the resilience and rate
limiting of **their own** OTP flows. Before each run the dashboard requires an
explicit authorization confirmation, which is recorded in the audit log together
with the operator, recipient, configuration and timestamps. Keep that
authorization documented on your side too - a test against a system you do not
own or have written permission to test is abuse, regardless of the tooling used.
