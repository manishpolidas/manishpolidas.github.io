# API reference

Base URL: `http://localhost:4000` (or `/api` behind the dashboard's proxy).
All bodies are JSON. All responses are `application/json` except `204` replies.

## Authentication model

* `POST /api/auth/login` sets two cookies: `otp_test_session` (HttpOnly, signed,
  SameSite=Strict) and `otp_test_csrf` (readable by the SPA).
* Every non-`GET` request must send the CSRF value in the `x-csrf-token` header.
* Roles: `admin` (create/start/pause/resume/stop/delete) and `viewer` (read-only).
* The WebSocket upgrade uses the same session cookie.

Error envelope:

```json
{ "error": "TEST_ALREADY_RUNNING", "message": "A test is already running for this session." }
```

Validation errors add `details`:

```json
{
  "error": "VALIDATION_ERROR",
  "message": "One or more test parameters are invalid.",
  "details": [{ "field": "messagesPerMinute", "message": "Messages per minute may not exceed the configured limit of 60." }]
}
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Payload/query failed validation |
| `AUTHORIZATION_NOT_ACKNOWLEDGED` | 400 | `authorizationAcknowledged` was not `true` |
| `UNAUTHENTICATED` | 401 | Missing/expired session, or bad credentials |
| `FORBIDDEN` | 403 | Role not permitted |
| `CSRF_TOKEN_INVALID` | 403 | Missing/incorrect `x-csrf-token` |
| `RECIPIENT_NOT_ALLOWED` | 403 | Not in `RECIPIENT_ALLOWLIST` (non-mock modes) |
| `TEST_NOT_FOUND` | 404 | Unknown test id |
| `TEST_ALREADY_RUNNING` | 409 | Duplicate start |
| `TEST_ALREADY_STOPPED` | 409 | Test is terminal |
| `TEST_NOT_RUNNING` / `TEST_NOT_PAUSED` | 409 | Invalid transition |
| `CONCURRENCY_LIMIT_REACHED` | 429 | `MAX_CONCURRENT_TESTS` reached |
| `RATE_LIMITED` | 429 | API rate limiter |
| `STORAGE_ERROR` | 503 | Database unavailable |
| `INTERNAL_ERROR` | 500 | Unexpected failure |

---

## `GET /api/health`

Public liveness probe.

```json
{ "status": "ok", "uptimeSeconds": 42 }
```

## `POST /api/auth/login`

```json
{ "username": "admin", "password": "admin123" }
```

```json
{
  "username": "admin",
  "role": "admin",
  "csrfToken": "u9F2...",
  "expiresAt": "2026-08-27T15:30:00.000Z"
}
```

Rate limited to 10 attempts per minute per IP. `401` on failure with the same
message for unknown user and wrong password.

## `POST /api/auth/logout`

`204 No Content`, cookies cleared.

## `GET /api/auth/session`

```json
{ "username": "admin", "role": "admin", "csrfToken": "u9F2..." }
```

## `GET /api/config`

Everything the dashboard needs; never credentials.

```json
{
  "smsMode": "mock",
  "providerName": "mock-sms-simulator",
  "limits": { "maxMessagesPerMinute": 60, "maxMessagesPerTest": 500, "maxDurationSeconds": 900, "maxConcurrentTests": 3 },
  "hardCaps": { "maxMessagesPerMinute": 600, "maxMessagesPerTest": 5000, "maxDurationSeconds": 3600, "maxConcurrentTests": 10 },
  "otpLength": { "min": 4, "max": 8, "default": 6 },
  "storePlaintextOtp": true,
  "persistence": "memory",
  "activeTests": 0,
  "recipientAllowlistRequired": false
}
```

## `GET /api/audit?limit=100`  *(admin)*

```json
{
  "items": [
    {
      "id": "5f0...",
      "at": "2026-08-27T14:30:00.000Z",
      "actor": "admin",
      "action": "test.start",
      "testId": "TEST-3F9A2B7C10",
      "detail": null,
      "ip": "127.0.0.1"
    }
  ]
}
```

---

## `POST /api/tests`  *(admin)*

Creates a test configuration. Nothing is generated or sent yet.

```json
{
  "recipient": "TEST-USER-001",
  "otpLength": 6,
  "messagesPerMinute": 10,
  "maxMessages": 50,
  "durationSeconds": 300,
  "testName": "login OTP soak",
  "authorizationAcknowledged": true
}
```

`201 Created`:

```json
{
  "test": {
    "id": "TEST-3F9A2B7C10",
    "testName": "login OTP soak",
    "recipient": "TEST-USER-001",
    "status": "CREATED",
    "smsMode": "mock",
    "otpLength": 6,
    "messagesPerMinute": 10,
    "maxMessages": 50,
    "durationSeconds": 300,
    "generated": 0,
    "sent": 0,
    "failed": 0,
    "createdBy": "admin",
    "stopReason": null,
    "createdAt": "2026-08-27T14:29:58.000Z",
    "startedAt": null,
    "pausedAt": null,
    "stoppedAt": null,
    "completedAt": null
  },
  "snapshot": {
    "testId": "TEST-3F9A2B7C10",
    "status": "CREATED",
    "generated": 0,
    "sent": 0,
    "failed": 0,
    "configuredRatePerMinute": 10,
    "observedRatePerMinute": 0,
    "remainingMessages": 50,
    "elapsedMs": 0,
    "remainingMs": 300000,
    "stopReason": null
  }
}
```

`authorizationAcknowledged` must be exactly `true`; unknown fields are rejected.

## `POST /api/tests/{testId}/start`  *(admin)*

```json
{ "test": { "id": "TEST-3F9A2B7C10", "status": "RUNNING", "startedAt": "2026-08-27T14:30:00.000Z" },
  "snapshot": { "status": "RUNNING" } }
```

`409 TEST_ALREADY_RUNNING` for a duplicate start, `409 TEST_ALREADY_STOPPED` for
a finished test, `429 CONCURRENCY_LIMIT_REACHED` when too many tests are live.

## `POST /api/tests/{testId}/pause`  *(admin)*

`200` with `status: "PAUSED"`. Already-dispatched sends finish; no new OTP is
generated while paused. `409 TEST_NOT_RUNNING` otherwise.

## `POST /api/tests/{testId}/resume`  *(admin)*

`200` with `status: "RUNNING"`. `409 TEST_NOT_PAUSED` otherwise.

## `POST /api/tests/{testId}/stop`  *(admin)*

Cancels the run. **The response is sent only after the scheduler has exited and
the terminal state has been persisted**, so a `200` means no further OTP request
can be created.

```json
{
  "test": {
    "id": "TEST-3F9A2B7C10",
    "status": "STOPPED",
    "stopReason": "USER_STOP",
    "generated": 23,
    "sent": 21,
    "failed": 2,
    "stoppedAt": "2026-08-27T14:32:30.000Z"
  },
  "snapshot": { "status": "STOPPED", "remainingMessages": 27 }
}
```

`409 TEST_ALREADY_STOPPED` if it already finished.

## `POST /api/tests/stop-all`  *(admin)*

Emergency stop for every live test.

```json
{ "stopped": ["TEST-3F9A2B7C10", "TEST-88C1D0E5A2"], "count": 2 }
```

## `GET /api/tests/{testId}`

```json
{ "test": { "id": "TEST-3F9A2B7C10", "status": "COMPLETED" }, "snapshot": { "status": "COMPLETED" } }
```

## `GET /api/tests/{testId}/logs?limit=500`

```json
{
  "items": [
    { "id": "a1", "testId": "TEST-3F9A2B7C10", "at": "2026-08-27T14:30:01.000Z", "level": "info", "event": "otp.generated", "message": "OTP generated #1 483921" },
    { "id": "a2", "testId": "TEST-3F9A2B7C10", "at": "2026-08-27T14:30:01.120Z", "level": "info", "event": "sms.simulated", "message": "SMS simulated SUCCESS #1 messageId=TEST-00001-9f2c1ab4 latency=118ms" },
    { "id": "a3", "testId": "TEST-3F9A2B7C10", "at": "2026-08-27T14:30:07.000Z", "level": "warn", "event": "sms.simulated", "message": "SMS simulated FAILURE #2 - Simulated delivery failure for TE********01 (message TEST-00002-4c7e9a11)." }
  ],
  "total": 3
}
```

Plaintext OTPs appear in the message only in LOCAL MOCK MODE with
`STORE_PLAINTEXT_OTP=true`; otherwise the line carries `hash:<first 8 hex>`.

## `GET /api/tests/{testId}/attempts?limit=500`

```json
{
  "items": [
    {
      "id": "b1",
      "testId": "TEST-3F9A2B7C10",
      "sequence": 1,
      "recipient": "TEST-USER-001",
      "otpHash": "9f2c... (64 hex chars)",
      "otpPlaintext": "483921",
      "status": "SENT",
      "providerMessageId": "TEST-00001-9f2c1ab4",
      "errorMessage": null,
      "latencyMs": 118,
      "createdAt": "2026-08-27T14:30:01.000Z",
      "completedAt": "2026-08-27T14:30:01.120Z"
    }
  ],
  "total": 1
}
```

## `GET /api/tests?limit=50&offset=0&status=COMPLETED`

Test history, newest first.

```json
{ "items": [], "snapshots": [], "total": 12, "limit": 50, "offset": 0 }
```

## `DELETE /api/tests/{testId}`  *(admin)*

Stops the test if it is live, then deletes it with its attempts and logs.
`204 No Content`.

---

## WebSocket `/ws`

Authenticated with the session cookie; an unauthenticated upgrade gets
`401` and the socket is destroyed. Server-to-client frames:

```json
{ "type": "hello",         "payload": { "activeTests": 0 } }
{ "type": "test.created",  "payload": { "testId": "TEST-3F9A2B7C10", "status": "CREATED" } }
{ "type": "test.update",   "payload": { "testId": "TEST-3F9A2B7C10", "status": "RUNNING", "generated": 25, "sent": 24, "failed": 1 } }
{ "type": "test.log",      "payload": { "id": "c1", "testId": "TEST-3F9A2B7C10", "at": "2026-08-27T14:30:26.000Z", "level": "info", "event": "otp.generated", "message": "OTP generated #26 729184" } }
{ "type": "test.finished", "payload": { "testId": "TEST-3F9A2B7C10", "status": "STOPPED", "stopReason": "USER_STOP" } }
{ "type": "test.deleted",  "payload": { "testId": "TEST-3F9A2B7C10" } }
```

The client sends nothing; the server pings every 30s and terminates sockets that
stop responding.

---

## curl walkthrough

```bash
# 1. sign in, keeping the cookie jar
curl -s -c jar.txt -X POST localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
# -> {"username":"admin","role":"admin","csrfToken":"CSRF","expiresAt":"..."}

CSRF=$(grep otp_test_csrf jar.txt | awk '{print $7}')

# 2. create
TEST_ID=$(curl -s -b jar.txt -X POST localhost:4000/api/tests \
  -H "content-type: application/json" -H "x-csrf-token: $CSRF" \
  -d '{"recipient":"TEST-USER-001","otpLength":6,"messagesPerMinute":10,
       "maxMessages":20,"durationSeconds":120,"testName":"curl run",
       "authorizationAcknowledged":true}' | sed -E 's/.*"id":"([^"]+)".*/\1/')

# 3. start, watch, stop
curl -s -b jar.txt -X POST "localhost:4000/api/tests/$TEST_ID/start" -H "x-csrf-token: $CSRF"
curl -s -b jar.txt "localhost:4000/api/tests/$TEST_ID"
curl -s -b jar.txt -X POST "localhost:4000/api/tests/$TEST_ID/stop" -H "x-csrf-token: $CSRF"
curl -s -b jar.txt "localhost:4000/api/tests/$TEST_ID/logs?limit=20"
```
