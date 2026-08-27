import type {
  LogEntry,
  OtpAttempt,
  PlatformConfig,
  Session,
  TestEnvelope,
  TestSession,
  TestSnapshot,
} from './types';

/** Error carrying the machine-readable code returned by the API. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: { field: string; message: string }[] | undefined;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const CSRF_COOKIE = 'otp_test_csrf';

function csrfToken(): string {
  const match = document.cookie.split('; ').find((entry) => entry.startsWith(`${CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE.length + 1)) : '';
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') headers.set('x-csrf-token', csrfToken());

  const response = await fetch(`/api${path}`, {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new ApiError(
      String(payload.error ?? 'INTERNAL_ERROR'),
      String(payload.message ?? response.statusText),
      response.status,
      payload.details as { field: string; message: string }[] | undefined,
    );
  }
  return payload as T;
}

export interface CreateTestInput {
  recipient: string;
  otpLength: number;
  messagesPerMinute: number;
  maxMessages: number;
  durationSeconds: number;
  testName: string | null;
  authorizationAcknowledged: true;
}

export const api = {
  login: (username: string, password: string) =>
    call<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => call<void>('/auth/logout', { method: 'POST' }),
  session: () => call<Session>('/auth/session'),
  config: () => call<PlatformConfig>('/config'),

  createTest: (input: CreateTestInput) =>
    call<TestEnvelope>('/tests', { method: 'POST', body: JSON.stringify(input) }),
  startTest: (testId: string) => call<TestEnvelope>(`/tests/${testId}/start`, { method: 'POST' }),
  pauseTest: (testId: string) => call<TestEnvelope>(`/tests/${testId}/pause`, { method: 'POST' }),
  resumeTest: (testId: string) => call<TestEnvelope>(`/tests/${testId}/resume`, { method: 'POST' }),
  stopTest: (testId: string) => call<TestEnvelope>(`/tests/${testId}/stop`, { method: 'POST' }),
  stopAll: () => call<{ stopped: string[]; count: number }>('/tests/stop-all', { method: 'POST' }),
  getTest: (testId: string) => call<TestEnvelope>(`/tests/${testId}`),
  deleteTest: (testId: string) => call<void>(`/tests/${testId}`, { method: 'DELETE' }),
  listTests: (limit = 25, offset = 0) =>
    call<{ items: TestSession[]; snapshots: TestSnapshot[]; total: number }>(
      `/tests?limit=${limit}&offset=${offset}`,
    ),
  logs: (testId: string, limit = 500) =>
    call<{ items: LogEntry[] }>(`/tests/${testId}/logs?limit=${limit}`),
  attempts: (testId: string, limit = 500) =>
    call<{ items: OtpAttempt[] }>(`/tests/${testId}/attempts?limit=${limit}`),
};
