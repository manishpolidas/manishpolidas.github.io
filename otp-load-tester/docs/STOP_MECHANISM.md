# How Stop guarantees that no new test requests are created

The requirement is absolute: **after Stop, the application must never create
another OTP request, and it must not keep running indefinitely.** This is how
that is enforced, and how it is tested.

## 1. One cancellation token owns the whole run

`TestRunner` (`server/src/services/scheduler.ts`) creates exactly one
`AbortController` when it is constructed. Three things observe its signal:

| Observer | Effect of abort |
| --- | --- |
| the pacing sleep (`delay(ms, signal)`) | rejects immediately with `CancelledError`; the `setTimeout` is cleared |
| the in-flight provider call (`sendOtp(..., { signal })`) | the mock provider's simulated latency aborts; the HTTP providers abort the `fetch` |
| the loop guard | `while (!signal.aborted)` plus a re-check right before OTP generation |

There is no second timer, no `setInterval`, and no queue of pre-scheduled jobs
anywhere in the runner - the only thing that can produce work is the loop, and
the loop is bound to that one signal.

## 2. The stop sequence

`TestService.stopTest` -> `TestRunner.stop(reason)` -> `performStop`:

```
1. status := STOPPING                     (persisted + broadcast immediately)
2. release the pause gate                 (a paused loop must be able to observe the abort)
3. controller.abort()                     (cancels sleep + in-flight send, blocks new work)
4. clear the duration watchdog timer
5. await the loop promise                 (bounded: one in-flight send)
6. status := STOPPED, stopReason, stoppedAt, broadcast, audit
```

Notes on each step:

* **Step 1** makes the intent visible before any awaiting happens, so the
  dashboard's Start button stays disabled and the API rejects a second start.
* **Step 2** matters because a paused loop is parked on a promise. Aborting alone
  would not wake it; the gate is released first, the loop wakes, sees
  `signal.aborted` and exits without dispatching. Release and abort happen in the
  same synchronous block, so the loop can never observe "unparked but not yet
  aborted".
* **Step 3** is the point of no return: `dispatchOne` begins with
  `if (this.controller.signal.aborted) return;`, so no OTP is generated, no
  attempt row is written and no provider call is made after this line runs.
* **Step 5** is why `stop()` is awaitable. It can only wait for a single send,
  and that send has already been aborted, so the wait is bounded rather than
  "until the provider feels like answering". The unit test for a provider with
  10s latency asserts that stop resolves in under 2 seconds.
* **Step 6** happens once. `finalize()` is guarded by a `finished` flag.

`stop()` is **idempotent**: the promise is memoised, so concurrent Stop clicks,
the watchdog and shutdown all join the same sequence instead of starting a second
one.

## 3. The in-flight request is cancelled, not orphaned

If a send is in progress when Stop arrives, the provider call rejects with a
cancellation. `dispatchOne` catches it, marks that attempt `CANCELLED` with
`errorMessage = "Cancelled by Stop request."`, logs `sms.cancelled` and rethrows.
The loop's catch treats cancellation as a normal exit. No attempt is ever left
`PENDING`.

## 4. Nothing can restart a stopped test

* `STOPPED`, `COMPLETED` and `FAILED` are terminal
  (`isTerminal` in `domain/types.ts`).
* `TestService.startTest` throws `TEST_ALREADY_STOPPED` for a terminal session
  and `TEST_ALREADY_RUNNING` for anything that is not `CREATED`.
* `onFinished` removes the runner from the registry, so no stale handle exists.
* A test object is single-use by design: to run the same configuration again you
  create a new test, which gets a new id and a fresh audit trail.

## 5. Belt and braces: independent stop conditions

| Condition | Detected by | Final status |
| --- | --- | --- |
| Operator presses Stop | `stop('USER_STOP')` | `STOPPED` |
| `maxMessages` reached | loop guard before each dispatch | `COMPLETED` |
| `durationSeconds` elapsed | loop guard + capped sleep | `COMPLETED` |
| Duration + grace elapsed while the loop is wedged | watchdog `setTimeout` | `COMPLETED` |
| Unexpected error in the loop | loop catch -> `stop('FATAL_ERROR')` | `FAILED` |
| Process shutdown (`SIGINT`/`SIGTERM`) | `stopAll('SERVER_SHUTDOWN')` | `STOPPED` |
| Crash/restart with rows left active | `reconcileInterruptedSessions()` at boot | `FAILED` |

The watchdog is the safety net for the pathological case where a provider hangs
and the loop cannot reach its next guard: it fires at
`durationSeconds + WATCHDOG_GRACE_MS` and runs the same stop sequence. Every
timer the runner creates is cleared in `clearWatchdog()`/`delay()`, so a stopped
test leaves nothing behind that could fire later.

`MAX_CONCURRENT_TESTS` bounds how many loops can exist at once, and the API's
`POST /api/tests/stop-all` (Emergency stop in the UI) stops all of them.

## 6. What the tests assert

`server/src/tests/stopMechanism.test.ts`:

* **start -> generate -> send -> stop -> nothing more**: after Stop, waiting
  several intervals shows the provider's send count and the session's `generated`
  counter frozen at the values they had when Stop returned, status `STOPPED`, and
  no `PENDING` attempts left behind.
* **in-flight cancellation**: with a 10s provider latency, Stop resolves in
  < 2s, the provider records one cancellation, and the last attempt is
  `CANCELLED`.
* **idempotency**: two concurrent Stops produce one terminal state; a third
  returns `TEST_ALREADY_STOPPED`.
* **no restart**: `startTest` after Stop rejects, and no further sends occur.
* **duplicate starts**: one succeeds, one gets `TEST_ALREADY_RUNNING`.
* **stop before start**: a `CREATED` test closes out as `STOPPED`.
* **emergency stop**: three live tests all end `STOPPED` and activity ceases.
* **shutdown**: `container.dispose()` stops the run and the provider is disposed.
* **restart reconciliation**: a row left `RUNNING` becomes `FAILED`.

`web/e2e/dashboard.spec.ts` asserts the same property through the UI: after
clicking **Stop Test**, the status reads `STOPPED`, the Stop button is disabled,
and the *Messages generated* value is unchanged two seconds later.
