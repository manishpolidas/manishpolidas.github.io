# Security and safety controls

## Modes, and why mock is the default

| Mode | Network | Recipient rule | Plaintext OTP retained |
| --- | --- | --- | --- |
| `mock` (**default**) | none - in-process simulator | any syntactically valid test id/number | optional (`STORE_PLAINTEXT_OTP`) |
| `sandbox` | vendor sandbox endpoint, no real delivery | must be in `RECIPIENT_ALLOWLIST` | never |
| `authorized` | real delivery through your own gateway | must be in `RECIPIENT_ALLOWLIST` | never |

Startup validation refuses to boot when a non-mock mode is selected without both
an endpoint and a non-empty allowlist (`config.ts`), so "accidentally sending
real SMS" is not a reachable state.

There is deliberately **no** capability for bypassing provider rate limits,
CAPTCHA, or anti-abuse controls, no retry-storm behaviour, and no way to target
recipients in bulk: a test has exactly one recipient, and its rate, volume and
duration are all capped.

## Authentication

* Dashboard login with scrypt-hashed passwords
  (`infrastructure/security/password.ts`, 64-byte key, per-user random salt,
  `timingSafeEqual` comparison).
* Sessions are stateless HMAC-SHA256-signed tokens with an expiry
  (`SESSION_TTL_SECONDS`), delivered as an `HttpOnly`, `SameSite=Strict`,
  `Secure`-in-production cookie.
* Login is rate limited to 10 attempts/minute/IP, and unknown-user and
  wrong-password answers are identical (no user enumeration).
* `DASHBOARD_PASSWORD` (plaintext) works only outside production; production
  requires `DASHBOARD_PASSWORD_HASH`. Generate one with
  `npm run hash-password -- '<password>'`.

## Authorization

* `admin` may create/start/pause/resume/stop/delete; `viewer` is read-only.
* Enforced twice: `requireRole('admin')` at the route and `assertCanExecute` in
  `TestService`, so a service-level caller cannot skip the check.
* Every mutating action is audit-logged with actor, action, test id, redacted
  detail and IP.

## CSRF

Double-submit cookie: the readable `otp_test_csrf` cookie must be echoed in the
`x-csrf-token` header for every non-`GET` request, and is compared with the value
bound inside the signed session cookie using a constant-time comparison. Combined
with `SameSite=Strict`, a cross-site form post cannot mutate anything.

## Input validation

* zod schemas in `domain/validation.ts`, built from the **current** limits, with
  `.strict()` so unknown fields are rejected.
* Recipients must match E.164 (`+?[1-9]\d{5,14}`) or a test identifier
  (`[A-Za-z0-9][A-Za-z0-9._-]{2,63}`) - no path traversal, no injection payloads.
* Test ids are re-validated in the route before any lookup.
* Request bodies are capped at 32 kB; malformed JSON returns
  `VALIDATION_ERROR`, not a stack trace.

## Rate limiting

Two independent layers:

1. **API limiter** - `API_RATE_LIMIT_PER_MINUTE` per session/IP, plus the
   stricter login limiter.
2. **Test rate limiter** - the scheduler paces sends to
   `messagesPerMinute` and never bursts to catch up.

## Safety limits

`MAX_MESSAGES_PER_MINUTE`, `MAX_MESSAGES_PER_TEST`, `MAX_DURATION_SECONDS` and
`MAX_CONCURRENT_TESTS` are operator-configurable but clamped to compiled-in
`HARD_CAPS` (600/min, 5000 messages, 3600 s, 10 concurrent). Limits are enforced
at create **and** at start, so tightening them stops queued tests from running.

Additional controls: the per-test authorization confirmation, the duration
watchdog, automatic timer cleanup, emergency stop-all, graceful-shutdown stop,
and startup reconciliation of sessions orphaned by a crash (see
[STOP_MECHANISM.md](STOP_MECHANISM.md)).

## Secrets and data handling

* All credentials come from environment variables. The frontend receives no
  secrets: `GET /api/config` returns modes and limits only, and the API test
  suite asserts the response contains no `password`/`secret`/`pepper`/`apiKey`
  substring.
* OTPs are stored as `HMAC-SHA256(otp, OTP_HASH_PEPPER)`. Plaintext is retained
  only in LOCAL MOCK MODE, and only while `STORE_PLAINTEXT_OTP=true`; the flag is
  forced off for every other mode.
* Recipients are masked (`TE********01`) in console output, audit details and
  provider error messages.
* Provider API keys are sent as an `Authorization` header and never logged; HTTP
  error bodies are truncated to 200 characters before being surfaced.
* Errors returned to clients carry a code and a safe message; stack traces stay
  on the server.

## Transport headers

`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin`, `Cache-Control: no-store`, a
`default-src 'none'` CSP for the JSON API, and HSTS in production. CORS is
credentialed but restricted to `CORS_ORIGINS`; the recommended deployment puts the
SPA and API on one origin (nginx/Vite proxy) so no cross-origin request is needed
at all.

## Deployment checklist

1. `SESSION_SECRET` - 32+ random bytes, unique per environment.
2. `OTP_HASH_PEPPER` - set, and rotated only with the understanding that old
   hashes stop matching.
3. `DASHBOARD_PASSWORD_HASH` - set; remove `DASHBOARD_PASSWORD`.
4. `SMS_MODE` - keep `mock` unless you have a documented authorization; for
   `sandbox`/`authorized`, populate `RECIPIENT_ALLOWLIST` with only the
   recipients you own.
5. Terminate TLS in front of the API, keep `CORS_ORIGINS` tight, and put the
   dashboard behind your own network controls (VPN/SSO) if it is reachable
   outside a workstation.
6. Set `PERSISTENCE=postgres` if you need the audit trail and history to survive
   restarts.
