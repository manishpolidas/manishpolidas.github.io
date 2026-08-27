import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { errors } from '../../domain/errors.js';

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  windowMs?: number;
  /** Defaults to the authenticated username, falling back to the client IP. */
  keyFor?: (req: Request) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Small fixed-window limiter. Protects the API itself (login brute force,
 * accidental client loops); the *test* rate limit is a separate, scheduler-level
 * control.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const windowMs = options.windowMs ?? 60_000;
  const buckets = new Map<string, Bucket>();
  const keyFor = options.keyFor ?? ((req) => req.principal?.username ?? req.ip ?? 'unknown');

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = keyFor(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    // Opportunistic cleanup keeps the map from growing without bound.
    if (buckets.size > 5_000) {
      for (const [existingKey, existing] of buckets) {
        if (existing.resetAt <= now) buckets.delete(existingKey);
      }
    }

    res.setHeader('x-ratelimit-limit', String(options.limit));
    res.setHeader('x-ratelimit-remaining', String(Math.max(0, options.limit - bucket.count)));
    res.setHeader('x-ratelimit-reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.limit) {
      res.setHeader('retry-after', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return next(errors.rateLimited());
    }
    next();
  };
}
