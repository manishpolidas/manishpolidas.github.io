import { Router } from 'express';
import type { Request } from 'express';
import { errors } from '../../domain/errors.js';
import { listQuerySchema, logsQuerySchema } from '../../domain/validation.js';
import { buildSnapshot } from '../../services/snapshot.js';
import type { Actor, TestService } from '../../services/testService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthService } from '../middleware/auth.js';
import { requireAuth, requireCsrf, requireRole } from '../middleware/auth.js';

function actorFrom(req: Request): Actor {
  if (!req.principal) throw errors.unauthenticated();
  return { username: req.principal.username, role: req.principal.role, ip: req.ip ?? null };
}

function testIdFrom(req: Request): string {
  const raw = req.params.testId;
  if (!raw || !/^[A-Za-z0-9._-]{1,64}$/.test(raw)) {
    throw errors.validation('Malformed test id.', { field: 'testId' });
  }
  return raw;
}

export function createTestsRouter(deps: { testService: TestService; auth: AuthService }): Router {
  const router = Router();
  const { testService } = deps;

  router.use(requireAuth(deps.auth), requireCsrf());

  // POST /api/tests - create a test configuration (does not start it).
  router.post(
    '/',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const session = await testService.createTest(req.body, actorFrom(req));
      res.status(201).json({ test: session, snapshot: buildSnapshot(session) });
    }),
  );

  // GET /api/tests - test history, newest first.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = listQuerySchema.parse(req.query);
      const result = await testService.listTests(query);
      res.json({
        items: result.items,
        snapshots: result.snapshots,
        total: result.total,
        limit: query.limit,
        offset: query.offset,
      });
    }),
  );

  // POST /api/tests/stop-all - emergency stop for every live test.
  router.post(
    '/stop-all',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const stopped = await testService.stopAll('USER_STOP', actorFrom(req));
      res.json({ stopped, count: stopped.length });
    }),
  );

  router.get(
    '/:testId',
    asyncHandler(async (req, res) => {
      const { session, snapshot } = await testService.getTest(testIdFrom(req));
      res.json({ test: session, snapshot });
    }),
  );

  router.post(
    '/:testId/start',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const session = await testService.startTest(testIdFrom(req), actorFrom(req));
      res.json({ test: session, snapshot: buildSnapshot(session) });
    }),
  );

  router.post(
    '/:testId/pause',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const session = await testService.pauseTest(testIdFrom(req), actorFrom(req));
      res.json({ test: session, snapshot: buildSnapshot(session) });
    }),
  );

  router.post(
    '/:testId/resume',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const session = await testService.resumeTest(testIdFrom(req), actorFrom(req));
      res.json({ test: session, snapshot: buildSnapshot(session) });
    }),
  );

  // POST /api/tests/{id}/stop - responds only after the scheduler has stopped.
  router.post(
    '/:testId/stop',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const session = await testService.stopTest(testIdFrom(req), actorFrom(req));
      res.json({ test: session, snapshot: buildSnapshot(session) });
    }),
  );

  router.get(
    '/:testId/logs',
    asyncHandler(async (req, res) => {
      const { limit } = logsQuerySchema.parse(req.query);
      const logs = await testService.getLogs(testIdFrom(req), limit);
      res.json({ items: logs, total: logs.length });
    }),
  );

  router.get(
    '/:testId/attempts',
    asyncHandler(async (req, res) => {
      const { limit } = logsQuerySchema.parse(req.query);
      const attempts = await testService.getAttempts(testIdFrom(req), limit);
      res.json({ items: attempts, total: attempts.length });
    }),
  );

  router.delete(
    '/:testId',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      await testService.deleteTest(testIdFrom(req), actorFrom(req));
      res.status(204).end();
    }),
  );

  return router;
}
