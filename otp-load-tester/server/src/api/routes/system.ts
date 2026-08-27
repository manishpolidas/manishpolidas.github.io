import { Router } from 'express';
import type { AppConfig } from '../../config.js';
import { HARD_CAPS, OTP_LENGTH_RANGE } from '../../domain/limits.js';
import type { TestRepository } from '../../infrastructure/repositories/TestRepository.js';
import type { SmsProvider } from '../../infrastructure/sms/SmsProvider.js';
import type { TestService } from '../../services/testService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthService } from '../middleware/auth.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export function createSystemRouter(deps: {
  config: AppConfig;
  auth: AuthService;
  provider: SmsProvider;
  repository: TestRepository;
  testService: TestService;
}): Router {
  const router = Router();
  const { config, provider } = deps;

  // Public liveness probe - no configuration is disclosed.
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  /**
   * Everything the dashboard needs to render its form and safety banner.
   * Contains limits and the provider *mode* - never credentials.
   */
  router.get('/config', requireAuth(deps.auth), (_req, res) => {
    res.json({
      smsMode: config.smsMode,
      providerName: provider.name,
      limits: config.limits,
      hardCaps: HARD_CAPS,
      otpLength: OTP_LENGTH_RANGE,
      storePlaintextOtp: config.storePlaintextOtp,
      persistence: config.persistence,
      activeTests: deps.testService.activeCount,
      recipientAllowlistRequired: config.smsMode !== 'mock',
    });
  });

  router.get(
    '/audit',
    requireAuth(deps.auth),
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const limit = Math.min(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
      res.json({ items: await deps.repository.listAudit(limit) });
    }),
  );

  return router;
}
