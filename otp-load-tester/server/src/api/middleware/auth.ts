import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig, DashboardUser, Role } from '../../config.js';
import { errors } from '../../domain/errors.js';
import { hashPassword, verifyPassword } from '../../infrastructure/security/password.js';
import {
  newCsrfToken,
  safeEqual,
  signSession,
  verifySession,
  type SessionPayload,
} from '../../infrastructure/security/session.js';

export interface Principal {
  username: string;
  role: Role;
  csrf: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class AuthService {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /** Verifies credentials in constant time-ish fashion and returns the user. */
  async authenticate(username: string, password: string): Promise<DashboardUser | null> {
    const user = this.config.users.find((candidate) => safeEqual(candidate.username, username));
    if (!user) {
      // Do the same scrypt work so an unknown username is not measurably faster.
      await hashPassword(password);
      return null;
    }
    if (user.passwordHash) {
      return (await verifyPassword(password, user.passwordHash)) ? user : null;
    }
    if (user.devPassword && !this.config.isProduction) {
      return safeEqual(user.devPassword, password) ? user : null;
    }
    return null;
  }

  issueSession(user: DashboardUser): { token: string; payload: SessionPayload } {
    const payload: SessionPayload = {
      username: user.username,
      role: user.role,
      csrf: newCsrfToken(),
      exp: Math.floor(Date.now() / 1000) + this.config.session.ttlSeconds,
    };
    return { token: signSession(payload, this.config.session.secret), payload };
  }

  setCookies(res: Response, token: string, payload: SessionPayload): void {
    const maxAge = this.config.session.ttlSeconds;
    const secure = this.config.isProduction;
    res.append(
      'set-cookie',
      serializeCookie(this.config.session.cookieName, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure,
        path: '/',
        maxAge,
      }),
    );
    // Readable by the SPA so it can echo the value in the x-csrf-token header.
    res.append(
      'set-cookie',
      serializeCookie(this.config.session.csrfCookieName, payload.csrf, {
        httpOnly: false,
        sameSite: 'strict',
        secure,
        path: '/',
        maxAge,
      }),
    );
  }

  clearCookies(res: Response): void {
    for (const name of [this.config.session.cookieName, this.config.session.csrfCookieName]) {
      res.append(
        'set-cookie',
        serializeCookie(name, '', {
          httpOnly: name === this.config.session.cookieName,
          sameSite: 'strict',
          secure: this.config.isProduction,
          path: '/',
          maxAge: 0,
        }),
      );
    }
  }

  /** Resolves the principal from the request cookies, or null. */
  principalFrom(req: { headers: { cookie?: string | undefined } }): Principal | null {
    const cookies = parseCookie(req.headers.cookie ?? '');
    const payload = verifySession(
      cookies[this.config.session.cookieName],
      this.config.session.secret,
    );
    if (!payload) return null;
    return { username: payload.username, role: payload.role, csrf: payload.csrf };
  }
}

/** 401s anything without a valid session cookie. */
export function requireAuth(auth: AuthService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const principal = auth.principalFrom(req);
    if (!principal) return next(errors.unauthenticated());
    req.principal = principal;
    next();
  };
}

/**
 * Double-submit CSRF check for state-changing requests: the `x-csrf-token`
 * header must match the token bound to the (httpOnly) session cookie.
 */
export function requireCsrf(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const header = req.get('x-csrf-token');
    if (!header || !req.principal || !safeEqual(header, req.principal.csrf)) {
      return next(errors.csrf());
    }
    next();
  };
}

/** Role gate. `admin` may execute tests; `viewer` is read-only. */
export function requireRole(role: Role): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.principal) return next(errors.unauthenticated());
    if (role === 'admin' && req.principal.role !== 'admin') {
      return next(errors.forbidden('Test execution requires the "admin" role.'));
    }
    next();
  };
}
