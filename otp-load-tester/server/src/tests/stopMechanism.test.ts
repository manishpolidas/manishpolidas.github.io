import { afterEach, describe, expect, it } from 'vitest';
import type { Container } from '../container.js';
import { AppError } from '../domain/errors.js';
import { delay } from '../services/time.js';
import {
  FakeSmsProvider,
  adminActor,
  baseTestPayload,
  testContainer,
  viewerActor,
  waitFor,
} from './helpers.js';

let container: Container | null = null;

afterEach(async () => {
  await container?.dispose();
  container = null;
});

describe('stop mechanism', () => {
  it('start -> generate -> send -> stop -> no further OTP requests are created', async () => {
    const provider = new FakeSmsProvider();
    const built = testContainer({}, { provider });
    container = built;

    const session = await built.testService.createTest(
      baseTestPayload({ messagesPerMinute: 600, maxMessages: 500, durationSeconds: 300 }),
      adminActor,
    );
    await built.testService.startTest(session.id, adminActor);
    await waitFor(() => provider.sendCount >= 2);

    const stopped = await built.testService.stopTest(session.id, adminActor);
    const sendsAtStop = provider.sendCount;
    const generatedAtStop = stopped.generated;

    expect(stopped.status).toBe('STOPPED');
    expect(stopped.stopReason).toBe('USER_STOP');
    expect(stopped.stoppedAt).not.toBeNull();

    // Give the scheduler several intervals' worth of time to misbehave.
    await delay(600);

    expect(provider.sendCount).toBe(sendsAtStop);
    const after = await built.testService.getTest(session.id);
    expect(after.session.generated).toBe(generatedAtStop);
    expect(after.session.status).toBe('STOPPED');

    const attempts = await built.testService.getAttempts(session.id, 500);
    expect(attempts).toHaveLength(generatedAtStop);
    expect(attempts.some((attempt) => attempt.status === 'PENDING')).toBe(false);
  });

  it('cancels the in-flight provider call instead of waiting for it', async () => {
    // A send that would take 10s: Stop must not block on it.
    const provider = new FakeSmsProvider({ latencyMs: 10_000 });
    const built = testContainer({}, { provider });
    container = built;

    const session = await built.testService.createTest(
      baseTestPayload({ messagesPerMinute: 600, maxMessages: 50, durationSeconds: 300 }),
      adminActor,
    );
    await built.testService.startTest(session.id, adminActor);
    await waitFor(() => provider.sendCount === 1);

    const startedAt = Date.now();
    const stopped = await built.testService.stopTest(session.id, adminActor);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    expect(stopped.status).toBe('STOPPED');
    expect(provider.cancelled).toBe(1);

    const attempts = await built.testService.getAttempts(session.id, 10);
    expect(attempts.at(-1)?.status).toBe('CANCELLED');
    expect(attempts.at(-1)?.errorMessage).toContain('Stop');
  });

  it('stop is idempotent and safe to call concurrently', async () => {
    const provider = new FakeSmsProvider({ latencyMs: 50 });
    const built = testContainer({}, { provider });
    container = built;

    const session = await built.testService.createTest(
      baseTestPayload({ messagesPerMinute: 600, maxMessages: 100, durationSeconds: 300 }),
      adminActor,
    );
    await built.testService.startTest(session.id, adminActor);
    await waitFor(() => provider.sendCount >= 1);

    const [first, second] = await Promise.all([
      built.testService.stopTest(session.id, adminActor),
      built.testService.stopTest(session.id, adminActor).catch((error: unknown) => error),
    ]);
    expect(first.status).toBe('STOPPED');
    // The second call either returns the same terminal state or reports that the
    // test has already finished - never a second stop sequence.
    if (second instanceof AppError) {
      expect(second.code).toBe('TEST_ALREADY_STOPPED');
    } else {
      expect((second as { status: string }).status).toBe('STOPPED');
    }

    await expect(built.testService.stopTest(session.id, adminActor)).rejects.toMatchObject({
      code: 'TEST_ALREADY_STOPPED',
    });
  });

  it('a stopped test can never be restarted', async () => {
    const provider = new FakeSmsProvider();
    const built = testContainer({}, { provider });
    container = built;

    const session = await built.testService.createTest(
      baseTestPayload({ messagesPerMinute: 600, maxMessages: 100, durationSeconds: 300 }),
      adminActor,
    );
    await built.testService.startTest(session.id, adminActor);
    await waitFor(() => provider.sendCount >= 1);
    await built.testService.stopTest(session.id, adminActor);

    await expect(built.testService.startTest(session.id, adminActor)).rejects.toMatchObject({
      code: 'TEST_ALREADY_STOPPED',
    });
    const sends = provider.sendCount;
    await delay(200);
    expect(provider.sendCount).toBe(sends);
  });

  it('rejects duplicate start requests', async () => {
    const provider = new FakeSmsProvider({ latencyMs: 20 });
    const built = testContainer({}, { provider });
    container = built;

    const session = await built.testService.createTest(
      baseTestPayload({ messagesPerMinute: 600, maxMessages: 100, durationSeconds: 300 }),
      adminActor,
    );
    const results = await Promise.allSettled([
      built.testService.startTest(session.id, adminActor),
      built.testService.startTest(session.id, adminActor),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('TEST_ALREADY_RUNNING');

    await built.testService.stopTest(session.id, adminActor);
  });

  it('stopping a test that was never started closes it out', async () => {
    const built = testContainer({}, { provider: new FakeSmsProvider() });
    container = built;
    const session = await built.testService.createTest(baseTestPayload(), adminActor);

    const stopped = await built.testService.stopTest(session.id, adminActor);
    expect(stopped.status).toBe('STOPPED');
    await expect(built.testService.startTest(session.id, adminActor)).rejects.toMatchObject({
      code: 'TEST_ALREADY_STOPPED',
    });
  });

  it('emergency stop-all cancels every live test', async () => {
    const provider = new FakeSmsProvider({ latencyMs: 30 });
    const built = testContainer({}, { provider });
    container = built;

    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const session = await built.testService.createTest(
        baseTestPayload({
          recipient: `TEST-USER-00${i + 1}`,
          messagesPerMinute: 600,
          maxMessages: 200,
          durationSeconds: 300,
        }),
        adminActor,
      );
      await built.testService.startTest(session.id, adminActor);
      ids.push(session.id);
    }
    await waitFor(() => provider.sendCount >= 3);

    const stopped = await built.testService.stopAll('USER_STOP', adminActor);
    expect(stopped).toHaveLength(3);
    expect(built.testService.activeCount).toBe(0);

    const sends = provider.sendCount;
    await delay(400);
    expect(provider.sendCount).toBe(sends);
    for (const id of ids) {
      expect((await built.testService.getTest(id)).session.status).toBe('STOPPED');
    }
  });

  it('enforces the concurrent-test limit', async () => {
    const provider = new FakeSmsProvider({ latencyMs: 20 });
    const built = testContainer({ MAX_CONCURRENT_TESTS: '2' }, { provider });
    container = built;

    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const session = await built.testService.createTest(
        baseTestPayload({ messagesPerMinute: 60, maxMessages: 100, durationSeconds: 300 }),
        adminActor,
      );
      ids.push(session.id);
    }
    await built.testService.startTest(ids[0] as string, adminActor);
    await built.testService.startTest(ids[1] as string, adminActor);

    await expect(built.testService.startTest(ids[2] as string, adminActor)).rejects.toMatchObject({
      code: 'CONCURRENCY_LIMIT_REACHED',
    });

    await built.testService.stopAll('USER_STOP', adminActor);
  });

  it('read-only accounts cannot start or stop tests', async () => {
    const built = testContainer({}, { provider: new FakeSmsProvider() });
    container = built;

    await expect(
      built.testService.createTest(baseTestPayload(), viewerActor),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const session = await built.testService.createTest(baseTestPayload(), adminActor);
    await expect(built.testService.startTest(session.id, viewerActor)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('shutdown stops running tests and marks nothing as resumable', async () => {
    const provider = new FakeSmsProvider({ latencyMs: 10 });
    const built = testContainer({}, { provider });
    container = built;

    const session = await built.testService.createTest(
      baseTestPayload({ messagesPerMinute: 600, maxMessages: 500, durationSeconds: 300 }),
      adminActor,
    );
    await built.testService.startTest(session.id, adminActor);
    await waitFor(() => provider.sendCount >= 1);

    await built.dispose();
    container = null;

    const sends = provider.sendCount;
    await delay(300);
    expect(provider.sendCount).toBe(sends);
    expect(provider.disposed).toBe(true);
  });

  it('closes out sessions orphaned by a restart', async () => {
    const built = testContainer({}, { provider: new FakeSmsProvider() });
    container = built;

    const session = await built.testService.createTest(baseTestPayload(), adminActor);
    // Simulate the row a crash would leave behind.
    await built.repository.updateSession(session.id, {
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });

    const reconciled = await built.testService.reconcileInterrupted();
    expect(reconciled).toContain(session.id);

    const { session: after } = await built.testService.getTest(session.id);
    expect(after.status).toBe('FAILED');
    expect(after.stopReason).toBe('SERVER_SHUTDOWN');
  });
});
