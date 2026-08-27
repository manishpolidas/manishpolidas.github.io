import { afterEach, describe, expect, it } from 'vitest';
import type { Container } from '../container.js';
import { delay } from '../services/time.js';
import { FakeSmsProvider, adminActor, baseTestPayload, testContainer, waitFor } from './helpers.js';

let container: Container | null = null;

afterEach(async () => {
  await container?.dispose();
  container = null;
});

async function startTest(
  provider: FakeSmsProvider,
  payload: Record<string, unknown>,
): Promise<{ container: Container; testId: string }> {
  const built = testContainer({}, { provider, watchdogGraceMs: 500 });
  container = built;
  const session = await built.testService.createTest(baseTestPayload(payload), adminActor);
  await built.testService.startTest(session.id, adminActor);
  return { container: built, testId: session.id };
}

describe('scheduler', () => {
  it('generates a unique OTP per request and sends each one exactly once', async () => {
    const provider = new FakeSmsProvider();
    const { container: built, testId } = await startTest(provider, {
      messagesPerMinute: 600,
      maxMessages: 8,
    });

    await waitFor(
      async () => (await built.testService.getTest(testId)).session.status === 'COMPLETED',
    );

    const otps = provider.sends.map((send) => send.otp);
    expect(otps).toHaveLength(8);
    expect(new Set(otps).size).toBe(8);
    expect(otps.every((otp) => /^\d{6}$/.test(otp))).toBe(true);
    expect(provider.sends.map((send) => send.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('stops at the configured maximum number of messages', async () => {
    const provider = new FakeSmsProvider();
    const { container: built, testId } = await startTest(provider, {
      messagesPerMinute: 600,
      maxMessages: 4,
      durationSeconds: 60,
    });

    await waitFor(
      async () => (await built.testService.getTest(testId)).session.status === 'COMPLETED',
    );
    const { session, snapshot } = await built.testService.getTest(testId);

    expect(session.generated).toBe(4);
    expect(session.sent).toBe(4);
    expect(session.stopReason).toBe('MAX_MESSAGES_REACHED');
    expect(snapshot.remainingMessages).toBe(0);

    // And nothing more is produced afterwards.
    await delay(250);
    expect(provider.sendCount).toBe(4);
  });

  it('honours the configured rate (messages per minute)', async () => {
    const provider = new FakeSmsProvider();
    const { container: built, testId } = await startTest(provider, {
      messagesPerMinute: 120, // one every 500ms
      maxMessages: 3,
      durationSeconds: 60,
    });

    await waitFor(
      async () => (await built.testService.getTest(testId)).session.status === 'COMPLETED',
      { timeoutMs: 8_000 },
    );

    const times = provider.sends.map((send) => send.at);
    expect(times).toHaveLength(3);
    const gaps = times.slice(1).map((at, index) => at - (times[index] as number));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(400);
      expect(gap).toBeLessThan(900);
    }

    const { snapshot } = await built.testService.getTest(testId);
    expect(snapshot.configuredRatePerMinute).toBe(120);
    expect(snapshot.observedRatePerMinute).toBeGreaterThan(0);
  });

  it('stops when the configured duration expires, even below the message cap', async () => {
    const provider = new FakeSmsProvider();
    const { container: built, testId } = await startTest(provider, {
      messagesPerMinute: 120,
      maxMessages: 500,
      durationSeconds: 1,
    });

    await waitFor(
      async () => (await built.testService.getTest(testId)).session.status === 'COMPLETED',
      { timeoutMs: 8_000 },
    );
    const { session, snapshot } = await built.testService.getTest(testId);

    expect(session.stopReason).toBe('DURATION_ELAPSED');
    expect(session.generated).toBeGreaterThan(0);
    expect(session.generated).toBeLessThan(500);
    expect(snapshot.remainingMs).toBe(0);
    expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(900);

    const countAtEnd = provider.sendCount;
    await delay(300);
    expect(provider.sendCount).toBe(countAtEnd);
  });

  it('pauses and resumes without losing counters', async () => {
    const provider = new FakeSmsProvider();
    const { container: built, testId } = await startTest(provider, {
      messagesPerMinute: 300, // one every 200ms
      maxMessages: 100,
      durationSeconds: 60,
    });

    await waitFor(() => provider.sendCount >= 2);
    await built.testService.pauseTest(testId, adminActor);
    const pausedAfter = provider.sendCount;
    expect((await built.testService.getTest(testId)).session.status).toBe('PAUSED');

    await delay(700);
    expect(provider.sendCount).toBe(pausedAfter);

    await built.testService.resumeTest(testId, adminActor);
    expect((await built.testService.getTest(testId)).session.status).toBe('RUNNING');
    await waitFor(() => provider.sendCount > pausedAfter);

    const { session } = await built.testService.getTest(testId);
    expect(session.generated).toBeGreaterThan(pausedAfter);
    await built.testService.stopTest(testId, adminActor);
  });

  it('counts provider failures without aborting the run', async () => {
    const provider = new FakeSmsProvider({ failEvery: 2 });
    const { container: built, testId } = await startTest(provider, {
      messagesPerMinute: 600,
      maxMessages: 6,
      durationSeconds: 60,
    });

    await waitFor(
      async () => (await built.testService.getTest(testId)).session.status === 'COMPLETED',
    );
    const { session } = await built.testService.getTest(testId);

    expect(session.generated).toBe(6);
    expect(session.failed).toBe(3);
    expect(session.sent).toBe(3);
  });

  it('writes an attempt row and activity log line per message', async () => {
    const provider = new FakeSmsProvider();
    const { container: built, testId } = await startTest(provider, {
      messagesPerMinute: 600,
      maxMessages: 3,
    });

    await waitFor(
      async () => (await built.testService.getTest(testId)).session.status === 'COMPLETED',
    );

    const attempts = await built.testService.getAttempts(testId, 100);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((attempt) => attempt.status === 'SENT')).toBe(true);
    expect(attempts.every((attempt) => /^[0-9a-f]{64}$/.test(attempt.otpHash))).toBe(true);
    expect(attempts.every((attempt) => attempt.providerMessageId !== null)).toBe(true);

    const logs = await built.testService.getLogs(testId, 500);
    expect(logs.filter((entry) => entry.event === 'otp.generated')).toHaveLength(3);
    expect(logs.filter((entry) => entry.event === 'sms.simulated')).toHaveLength(3);
    expect(logs.at(-1)?.event).toBe('test.finished');
  });

  it('does not persist plaintext OTPs when plaintext storage is disabled', async () => {
    const provider = new FakeSmsProvider();
    const built = testContainer({ STORE_PLAINTEXT_OTP: 'false' }, { provider });
    container = built;
    const session = await built.testService.createTest(
      baseTestPayload({ maxMessages: 2, messagesPerMinute: 600 }),
      adminActor,
    );
    await built.testService.startTest(session.id, adminActor);
    await waitFor(
      async () => (await built.testService.getTest(session.id)).session.status === 'COMPLETED',
    );

    const attempts = await built.testService.getAttempts(session.id, 10);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.otpPlaintext === null)).toBe(true);

    const logs = await built.testService.getLogs(session.id, 100);
    const generatedLines = logs.filter((entry) => entry.event === 'otp.generated');
    expect(generatedLines.every((entry) => entry.message.includes('hash:'))).toBe(true);
    for (const send of provider.sends) {
      expect(generatedLines.some((entry) => entry.message.includes(send.otp))).toBe(false);
    }
  });
});
