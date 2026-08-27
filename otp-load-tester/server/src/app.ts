import express, { type Express, type RequestHandler } from 'express';
import type { AppConfig } from './config.js';
import { AuthService } from './api/middleware/auth.js';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler.js';
import { rateLimit } from './api/middleware/rateLimit.js';
import { createAuthRouter } from './api/routes/auth.js';
import { createSystemRouter } from './api/routes/system.js';
import { createTestsRouter } from './api/routes/tests.js';
import type { Container } from './container.js';

/** Builds the HTTP application. No listening, no side effects - testable. */
export function createApp(container: Container): Express {
  const { config } = container;
  const auth = new AuthService(config);
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders(config));
  app.use(cors(config));
  app.use(express.json({ limit: '32kb' }));
  app.use(rateLimit({ limit: config.apiRateLimitPerMinute }));

  app.use(
    '/api',
    createSystemRouter({
      config,
      auth,
      provider: container.provider,
      repository: container.repository,
      testService: container.testService,
    }),
  );
  app.use('/api/auth', createAuthRouter({ config, auth, logger: container.logger }));
  app.use('/api/tests', createTestsRouter({ testService: container.testService, auth }));

  app.use(notFoundHandler);
  app.use(errorHandler({ verbose: !config.isProduction }));

  // Exposed so the WebSocket upgrade can reuse the same session verification.
  Object.defineProperty(app, 'authService', { value: auth, enumerable: false });
  return app;
}

export function authServiceOf(app: Express): AuthService {
  return (app as unknown as { authService: AuthService }).authService;
}

function securityHeaders(config: AppConfig): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('cache-control', 'no-store');
    // The API serves JSON only; block anything that tries to render from it.
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (config.isProduction) {
      res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

/** Credentialed CORS, restricted to the configured dashboard origins. */
function cors(config: AppConfig): RequestHandler {
  const allowed = new Set(config.corsOrigins);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'content-type, x-csrf-token');
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(origin && allowed.has(origin) ? 204 : 403).end();
      return;
    }
    next();
  };
}
