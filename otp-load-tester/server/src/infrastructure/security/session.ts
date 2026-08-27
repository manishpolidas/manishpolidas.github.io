import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Role } from '../../config.js';

export interface SessionPayload {
  username: string;
  role: Role;
  /** CSRF token bound to this session (double-submit cookie pattern). */
  csrf: string;
  /** Expiry as a unix timestamp in seconds. */
  exp: number;
}

/** Signs a stateless session token: `<base64url(payload)>.<base64url(hmac)>`. */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${base64url(hmac(body, secret))}`;
}

export function verifySession(token: string | undefined, secret: string): SessionPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = base64url(hmac(body, secret));
  if (!safeEqual(signature, expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload?.username !== 'string' || typeof payload?.exp !== 'number') return null;
  if (payload.exp * 1000 <= Date.now()) return null;
  if (payload.role !== 'admin' && payload.role !== 'viewer') return null;
  return payload;
}

export function newCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

function hmac(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
