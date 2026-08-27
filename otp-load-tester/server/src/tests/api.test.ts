import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { Container } from '../container.js';
import { FakeSmsProvider, TEST_USER, baseTestPayload, testContainer } from './helpers.js';

let container: Container;
let app: Express;
let provider: FakeSmsProvider;

/** Logged-in supertest agent plus the CSRF token bound to its session. */
async function login(
  target: Express = app,
  credentials = TEST_USER,
): Promise<{ agent: ReturnType<typeof request.agent>; csrf: string }> {
  const agent = request.agent(target);
  const response = await agent.post('/api/auth/login').send(credentials).expect(200);
  return { agent, csrf: response.body.csrfToken as string };
}

beforeEach(() => {
  provider = new FakeSmsProvider({ latencyMs: 5 });
  container = testContainer({}, { provider });
  app = createApp(container);
});

afterEach(async () => {
  await container.dispose();
});

describe('GET /api/health', () => {
  it('is public and discloses no configuration', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.body).toMatchObject({ status: 'ok' });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });
});

describe('authentication', () => {
  it('rejects unauthenticated access to the API', async () => {
    await request(app).get('/api/config').expect(401);
    await request(app).get('/api/tests').expect(401);
    await request(app).post('/api/tests').send(baseTestPayload()).expect(401);
  });

  it('rejects bad credentials with a generic message', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER.username, password: 'wrong-password' })
      .expect(401);
    expect(response.body).toMatchObject({ error: 'UNAUTHENTICATED' });
    expect(response.body.message).toBe('Invalid username or password.');

    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'wrong-password' })
      .expect(401);
    expect(unknown.body.message).toBe(response.body.message);
  });

  it('issues an httpOnly session cookie and a readable CSRF cookie', async () => {
    const response = await request(app).post('/api/auth/login').send(TEST_USER).expect(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((cookie) => cookie.startsWith('otp_test_session='));
    const csrf = cookies.find((cookie) => cookie.startsWith('otp_test_csrf='));

    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Strict');
    expect(csrf).not.toContain('HttpOnly');
    expect(response.body).toMatchObject({ username: TEST_USER.username, role: 'admin' });
    expect(response.body.csrfToken).toBeTruthy();
  });

  it('requires the CSRF header on state-changing requests', async () => {
    const { agent } = await login();
    const response = await agent.post('/api/tests').send(baseTestPayload()).expect(403);
    expect(response.body).toMatchObject({ error: 'CSRF_TOKEN_INVALID' });

    const wrongToken = await agent
      .post('/api/tests')
      .set('x-csrf-token', 'not-the-right-token')
      .send(baseTestPayload())
      .expect(403);
    expect(wrongToken.body.error).toBe('CSRF_TOKEN_INVALID');
  });

  it('returns and then clears the session', async () => {
    const { agent } = await login();
    await agent.get('/api/auth/session').expect(200);
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/session').expect(401);
  });
});

describe('GET /api/config', () => {
  it('exposes limits and mode but never credentials', async () => {
    const { agent } = await login();
    const response = await agent.get('/api/config').expect(200);
    expect(response.body).toMatchObject({
      smsMode: 'mock',
      limits: { maxMessagesPerMinute: 600 },
      otpLength: { min: 4, max: 8, default: 6 },
      persistence: 'memory',
    });
    const body = JSON.stringify(response.body).toLowerCase();
    for (const word of ['password', 'secret', 'pepper', 'apikey', 'databaseurl']) {
      expect(body).not.toContain(word);
    }
  });
});

describe('test lifecycle over HTTP', () => {
  it('creates, starts, pauses, resumes, stops and deletes a test', async () => {
    const { agent, csrf } = await login();

    const created = await agent
      .post('/api/tests')
      .set('x-csrf-token', csrf)
      .send(baseTestPayload({ messagesPerMinute: 600, maxMessages: 100, durationSeconds: 120 }))
      .expect(201);
    const testId = created.body.test.id as string;
    expect(testId).toMatch(/^TEST-[0-9A-F]{10}$/);
    expect(created.body.test.status).toBe('CREATED');
    expect(created.body.snapshot.remainingMessages).toBe(100);

    const started = await agent
      .post(`/api/tests/${testId}/start`)
      .set('x-csrf-token', csrf)
      .expect(200);
    expect(started.body.test.status).toBe('RUNNING');
    expect(started.body.test.startedAt).not.toBeNull();

    const paused = await agent
      .post(`/api/tests/${testId}/pause`)
      .set('x-csrf-token', csrf)
      .expect(200);
    expect(paused.body.test.status).toBe('PAUSED');

    const resumed = await agent
      .post(`/api/tests/${testId}/resume`)
      .set('x-csrf-token', csrf)
      .expect(200);
    expect(resumed.body.test.status).toBe('RUNNING');

    const stopped = await agent
      .post(`/api/tests/${testId}/stop`)
      .set('x-csrf-token', csrf)
      .expect(200);
    expect(stopped.body.test.status).toBe('STOPPED');
    expect(stopped.body.test.stopReason).toBe('USER_STOP');

    const fetched = await agent.get(`/api/tests/${testId}`).expect(200);
    expect(fetched.body.test.status).toBe('STOPPED');

    const logs = await agent.get(`/api/tests/${testId}/logs`).expect(200);
    expect(logs.body.items.length).toBeGreaterThan(0);
    expect(logs.body.items.at(-1).event).toBe('test.finished');

    const attempts = await agent.get(`/api/tests/${testId}/attempts`).expect(200);
    expect(attempts.body.items.length).toBe(stopped.body.test.generated);

    const list = await agent.get('/api/tests?limit=10&offset=0').expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].id).toBe(testId);

    await agent.delete(`/api/tests/${testId}`).set('x-csrf-token', csrf).expect(204);
    await agent.get(`/api/tests/${testId}`).expect(404);
  });

  it('reports meaningful errors for invalid state transitions', async () => {
    const { agent, csrf } = await login();
    const created = await agent
      .post('/api/tests')
      .set('x-csrf-token', csrf)
      .send(baseTestPayload({ messagesPerMinute: 600, maxMessages: 50, durationSeconds: 120 }))
      .expect(201);
    const testId = created.body.test.id as string;

    // Not running yet.
    const pauseTooEarly = await agent
      .post(`/api/tests/${testId}/pause`)
      .set('x-csrf-token', csrf)
      .expect(409);
    expect(pauseTooEarly.body.error).toBe('TEST_NOT_RUNNING');

    await agent.post(`/api/tests/${testId}/start`).set('x-csrf-token', csrf).expect(200);

    const startTwice = await agent
      .post(`/api/tests/${testId}/start`)
      .set('x-csrf-token', csrf)
      .expect(409);
    expect(startTwice.body).toMatchObject({
      error: 'TEST_ALREADY_RUNNING',
      message: 'A test is already running for this session.',
    });

    const resumeWhileRunning = await agent
      .post(`/api/tests/${testId}/resume`)
      .set('x-csrf-token', csrf)
      .expect(409);
    expect(resumeWhileRunning.body.error).toBe('TEST_NOT_PAUSED');

    await agent.post(`/api/tests/${testId}/stop`).set('x-csrf-token', csrf).expect(200);

    const stopTwice = await agent
      .post(`/api/tests/${testId}/stop`)
      .set('x-csrf-token', csrf)
      .expect(409);
    expect(stopTwice.body.error).toBe('TEST_ALREADY_STOPPED');

    const restart = await agent
      .post(`/api/tests/${testId}/start`)
      .set('x-csrf-token', csrf)
      .expect(409);
    expect(restart.body.error).toBe('TEST_ALREADY_STOPPED');
  });

  it('validates the create payload', async () => {
    const { agent, csrf } = await login();

    const invalid = await agent
      .post('/api/tests')
      .set('x-csrf-token', csrf)
      .send(baseTestPayload({ recipient: 'no', messagesPerMinute: 0, otpLength: 12 }))
      .expect(400);
    expect(invalid.body.error).toBe('VALIDATION_ERROR');
    const fields = (invalid.body.details as { field: string }[]).map((detail) => detail.field);
    expect(fields).toContain('recipient');
    expect(fields).toContain('messagesPerMinute');
    expect(fields).toContain('otpLength');

    const unauthorized = await agent
      .post('/api/tests')
      .set('x-csrf-token', csrf)
      .send(baseTestPayload({ authorizationAcknowledged: false }))
      .expect(400);
    expect(unauthorized.body.error).toBe('AUTHORIZATION_NOT_ACKNOWLEDGED');

    const overLimit = await agent
      .post('/api/tests')
      .set('x-csrf-token', csrf)
      .send(baseTestPayload({ messagesPerMinute: 100_000 }))
      .expect(400);
    expect(overLimit.body.error).toBe('VALIDATION_ERROR');
  });

  it('emergency stop-all stops every live test', async () => {
    const { agent, csrf } = await login();
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const created = await agent
        .post('/api/tests')
        .set('x-csrf-token', csrf)
        .send(baseTestPayload({ messagesPerMinute: 600, maxMessages: 100, durationSeconds: 120 }))
        .expect(201);
      ids.push(created.body.test.id as string);
      await agent
        .post(`/api/tests/${created.body.test.id}/start`)
        .set('x-csrf-token', csrf)
        .expect(200);
    }

    const response = await agent.post('/api/tests/stop-all').set('x-csrf-token', csrf).expect(200);
    expect(response.body.count).toBe(2);
    for (const id of ids) {
      const fetched = await agent.get(`/api/tests/${id}`).expect(200);
      expect(fetched.body.test.status).toBe('STOPPED');
    }
  });

  it('404s unknown tests and unknown routes', async () => {
    const { agent } = await login();
    const missing = await agent.get('/api/tests/TEST-DOES-NOT-EXIST').expect(404);
    expect(missing.body.error).toBe('TEST_NOT_FOUND');

    const route = await agent.get('/api/nope').expect(404);
    expect(route.body.error).toBe('NOT_FOUND');
  });

  it('rejects malformed JSON bodies', async () => {
    const { agent, csrf } = await login();
    const response = await agent
      .post('/api/tests')
      .set('x-csrf-token', csrf)
      .set('content-type', 'application/json')
      .send('{"recipient": ')
      .expect(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });
});

describe('authorization', () => {
  it('lets viewers read but not execute', async () => {
    const viewerContainer = testContainer(
      {
        DASHBOARD_USERS_JSON: JSON.stringify([
          { username: 'admin', password: 'password123', role: 'admin' },
          { username: 'reader', password: 'password123', role: 'viewer' },
        ]),
      },
      { provider: new FakeSmsProvider() },
    );
    const viewerApp = createApp(viewerContainer);
    try {
      const { agent: adminAgent, csrf: adminCsrf } = await login(viewerApp, {
        username: 'admin',
        password: 'password123',
      });
      const created = await adminAgent
        .post('/api/tests')
        .set('x-csrf-token', adminCsrf)
        .send(baseTestPayload())
        .expect(201);

      const { agent, csrf } = await login(viewerApp, {
        username: 'reader',
        password: 'password123',
      });
      await agent.get('/api/tests').expect(200);
      await agent.get(`/api/tests/${created.body.test.id}`).expect(200);

      const forbidden = await agent
        .post('/api/tests')
        .set('x-csrf-token', csrf)
        .send(baseTestPayload())
        .expect(403);
      expect(forbidden.body.error).toBe('FORBIDDEN');

      await agent
        .post(`/api/tests/${created.body.test.id}/start`)
        .set('x-csrf-token', csrf)
        .expect(403);
      await agent
        .delete(`/api/tests/${created.body.test.id}`)
        .set('x-csrf-token', csrf)
        .expect(403);
    } finally {
      await viewerContainer.dispose();
    }
  });
});

describe('API rate limiting', () => {
  it('returns 429 once the window is exhausted', async () => {
    const limited = testContainer(
      { API_RATE_LIMIT_PER_MINUTE: '3' },
      { provider: new FakeSmsProvider() },
    );
    const limitedApp = createApp(limited);
    try {
      await request(limitedApp).get('/api/health').expect(200);
      await request(limitedApp).get('/api/health').expect(200);
      await request(limitedApp).get('/api/health').expect(200);
      const response = await request(limitedApp).get('/api/health').expect(429);
      expect(response.body.error).toBe('RATE_LIMITED');
      expect(response.headers['retry-after']).toBeDefined();
    } finally {
      await limited.dispose();
    }
  });
});
