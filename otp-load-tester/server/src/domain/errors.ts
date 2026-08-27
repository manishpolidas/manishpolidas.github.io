/** Machine readable error codes returned by the API. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHORIZATION_NOT_ACKNOWLEDGED'
  | 'RECIPIENT_NOT_ALLOWED'
  | 'TEST_NOT_FOUND'
  | 'TEST_ALREADY_RUNNING'
  | 'TEST_ALREADY_STOPPED'
  | 'TEST_NOT_RUNNING'
  | 'TEST_NOT_PAUSED'
  | 'CONCURRENCY_LIMIT_REACHED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'CSRF_TOKEN_INVALID'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'REQUEST_CANCELLED'
  | 'STORAGE_ERROR'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON() {
    return this.details === undefined
      ? { error: this.code, message: this.message }
      : { error: this.code, message: this.message, details: this.details };
  }
}

export const errors = {
  validation: (message: string, details?: unknown) =>
    new AppError('VALIDATION_ERROR', message, 400, details),
  notFound: (testId: string) =>
    new AppError('TEST_NOT_FOUND', `No test found with id "${testId}".`, 404),
  alreadyRunning: (testId: string) =>
    new AppError('TEST_ALREADY_RUNNING', 'A test is already running for this session.', 409, {
      testId,
    }),
  alreadyStopped: (testId: string) =>
    new AppError(
      'TEST_ALREADY_STOPPED',
      'This test has already finished. Create a new test to run again.',
      409,
      { testId },
    ),
  notRunning: (testId: string) =>
    new AppError('TEST_NOT_RUNNING', 'This test is not currently running.', 409, { testId }),
  notPaused: (testId: string) =>
    new AppError('TEST_NOT_PAUSED', 'This test is not currently paused.', 409, { testId }),
  concurrencyLimit: (limit: number) =>
    new AppError(
      'CONCURRENCY_LIMIT_REACHED',
      `Too many tests are running concurrently (limit ${limit}). Stop one first.`,
      429,
    ),
  authorizationNotAcknowledged: () =>
    new AppError(
      'AUTHORIZATION_NOT_ACKNOWLEDGED',
      'You must confirm that you are authorized to test this recipient/system.',
      400,
    ),
  recipientNotAllowed: (recipient: string) =>
    new AppError(
      'RECIPIENT_NOT_ALLOWED',
      `Recipient "${recipient}" is not present in RECIPIENT_ALLOWLIST. ` +
        'Non-mock modes may only target explicitly allowlisted recipients.',
      403,
    ),
  unauthenticated: () => new AppError('UNAUTHENTICATED', 'Sign in to continue.', 401),
  forbidden: (message = 'Your account is not permitted to perform this action.') =>
    new AppError('FORBIDDEN', message, 403),
  csrf: () => new AppError('CSRF_TOKEN_INVALID', 'Missing or invalid CSRF token.', 403),
  rateLimited: () =>
    new AppError('RATE_LIMITED', 'Too many requests. Slow down and try again.', 429),
  storage: (message: string) => new AppError('STORAGE_ERROR', message, 503),
  internal: (message = 'Unexpected server error.') => new AppError('INTERNAL_ERROR', message, 500),
};
