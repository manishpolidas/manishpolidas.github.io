import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authServiceOf, createApp } from '../app.js';
import { attachRealtime, type RealtimeServer } from '../api/ws/wsServer.js';
import type { Container } from '../container.js';
import { FakeSmsProvider, TEST_USER, baseTestPayload, testContainer, waitFor } from './helpers.js';

let container: Container;
let server: Server;
let realtime: RealtimeServer;
let port: number;

beforeEach(async () => {
  container = testContainer({}, { provider: new FakeSmsProvider({ latencyMs: 2 }) });
  const app = createApp(container);
  server = createServer(app);
  realtime = attachRealtime({
    server,
    bus: container.bus,
    auth: authServiceOf(app),
    testService: container.testService,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await container.dispose();
});

/** Logs in and returns the raw cookie header plus the CSRF token. */
async function loginRaw(): Promise<{ cookie: string; csrf: string }> {
  const response = await request(server).post('/api/auth/login').send(TEST_USER).expect(200);
  const cookies = response.headers['set-cookie'] as unknown as string[];
  return {
    cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; '),
    csrf: response.body.csrfToken as string,
  };
}

function connect(headers: Record<string, string> = {}): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
}

describe('realtime updates', () => {
  it('rejects an unauthenticated upgrade', async () => {
    const socket = connect();
    const status = await new Promise<number | string>((resolve) => {
      socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      socket.on('error', (error) => resolve(error.message));
      socket.on('open', () => resolve('opened'));
    });
    socket.close();
    expect(status).not.toBe('opened');
  });

  it('streams snapshots and log lines to an authenticated dashboard', async () => {
    const { cookie, csrf } = await loginRaw();
    const socket = connect({ cookie });
    const frames: { type: string; payload: Record<string, unknown> }[] = [];

    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    socket.on('message', (data) => {
      frames.push(JSON.parse(String(data)) as { type: string; payload: Record<string, unknown> });
    });

    const created = await request(server)
      .post('/api/tests')
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .send(baseTestPayload({ messagesPerMinute: 600, maxMessages: 3, durationSeconds: 60 }))
      .expect(201);
    const testId = created.body.test.id as string;

    await request(server)
      .post(`/api/tests/${testId}/start`)
      .set('cookie', cookie)
      .set('x-csrf-token', csrf)
      .expect(200);

    await waitFor(() => frames.some((frame) => frame.type === 'test.finished'), {
      timeoutMs: 8_000,
    });
    socket.close();

    expect(frames[0]?.type).toBe('hello');
    expect(frames.some((frame) => frame.type === 'test.created')).toBe(true);
    expect(frames.filter((frame) => frame.type === 'test.update').length).toBeGreaterThan(2);
    expect(frames.some((frame) => frame.type === 'test.log')).toBe(true);

    const finished = frames.find((frame) => frame.type === 'test.finished');
    expect(finished?.payload).toMatchObject({ testId, status: 'COMPLETED', generated: 3, sent: 3 });
  });
});
