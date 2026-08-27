import { Router } from 'express';
import type { AppConfig } from '../../config.js';
import { AppError, errors } from '../../domain/errors.js';
import { loginSchema } from '../../domain/validation.js';
import type { LoggingService } from '../../services/loggingService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { AuthService, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

export function createAuthRouter(deps: {
  config: AppConfig;
  auth: AuthService;
  logger: LoggingService;
}): Router {
  const router = Router();
  const { auth, logger } = deps;

  // Deliberately tight: this is the brute-force surface.
  const loginLimiter = rateLimit({
    limit: 10,
    windowMs: 60_000,
    keyFor: (req) => `login:${req.ip ?? 'unknown'}`,
  });

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const { username, password } = loginSchema.parse(req.body);
      const user = await auth.authenticate(username, password);
      if (!user) {
        await logger.audit({
          actor: username,
          action: 'auth.login_failed',
          ip: req.ip ?? null,
        });
        // Same message for unknown user and wrong password: no user enumeration.
        throw new AppError('UNAUTHENTICATED', 'Invalid username or password.', 401);
      }
      const { token, payload } = auth.issueSession(user);
      auth.setCookies(res, token, payload);
      await logger.audit({ actor: user.username, action: 'auth.login', ip: req.ip ?? null });
      res.json({
        username: user.username,
        role: user.role,
        csrfToken: payload.csrf,
        expiresAt: new Date(payload.exp * 1000).toISOString(),
      });
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const principal = auth.principalFrom(req);
      auth.clearCookies(res);
      if (principal) {
        await logger.audit({
          actor: principal.username,
          action: 'auth.logout',
          ip: req.ip ?? null,
        });
      }
      res.status(204).end();
    }),
  );

  router.get('/session', requireAuth(auth), (req, res) => {
    if (!req.principal) throw errors.unauthenticated();
    res.json({
      username: req.principal.username,
      role: req.principal.role,
      csrfToken: req.principal.csrf,
    });
  });

  return router;
}
