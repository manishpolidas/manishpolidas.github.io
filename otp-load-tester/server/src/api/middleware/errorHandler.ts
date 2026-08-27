import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, errors } from '../../domain/errors.js';
import { isCancellation } from '../../services/time.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}.` });
};

/**
 * Single place where errors become responses. Client-safe messages only: no
 * stack traces, no credentials, no provider secrets.
 */
export function errorHandler(options: { verbose?: boolean } = {}): ErrorRequestHandler {
  const verbose = options.verbose ?? true;
  return (error, _req, res, next) => {
    if (res.headersSent) return next(error);

    if (error instanceof AppError) {
      res.status(error.status).json(error.toJSON());
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json(
        errors
          .validation(
            'Invalid request payload.',
            error.issues.map((issue) => ({
              field: issue.path.join('.') || '(body)',
              message: issue.message,
            })),
          )
          .toJSON(),
      );
      return;
    }
    if (isCancellation(error)) {
      res.status(499).json({ error: 'REQUEST_CANCELLED', message: 'The request was cancelled.' });
      return;
    }
    if (isBodyParseError(error)) {
      res
        .status(400)
        .json({ error: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.' });
      return;
    }

    if (verbose) console.error('[api] unhandled error', error);
    res.status(500).json(errors.internal().toJSON());
  };
}

function isBodyParseError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as { type?: string }).type === 'entity.parse.failed'
  );
}
