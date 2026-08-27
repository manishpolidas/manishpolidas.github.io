import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { authServiceOf, createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { buildContainer } from './container.js';
import { attachRealtime } from './api/ws/wsServer.js';
import { PostgresTestRepository } from './infrastructure/repositories/PostgresTestRepository.js';

/**
 * Loads a .env file if one is present, without pulling in dotenv (Node's own
 * process.loadEnvFile). Looks in the server workspace first, then the project
 * root, so `npm run dev` works from either directory. In Docker/CI the
 * environment is provided directly and no file is needed.
 */
function loadEnvFile(): void {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')]) {
    if (!existsSync(candidate)) continue;
    try {
      process.loadEnvFile(candidate);
      console.log(`[config] loaded ${candidate}`);
    } catch (error) {
      console.warn(`[config] could not read ${candidate}: ${String(error)}`);
    }
    return;
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const container = buildContainer(config);

  if (container.repository instanceof PostgresTestRepository) {
    await container.repository.migrate();
    console.log('[db] schema applied');
  }

  // A restart can never resume scheduled work: close out orphaned sessions.
  const interrupted = await container.testService.reconcileInterrupted();
  if (interrupted.length > 0) {
    console.warn(`[startup] marked ${interrupted.length} interrupted test(s) as FAILED`);
  }

  const app = createApp(container);
  const server = createServer(app);
  const realtime = attachRealtime({
    server,
    bus: container.bus,
    auth: authServiceOf(app),
    testService: container.testService,
  });

  server.listen(config.port, () => {
    console.log(
      `[server] listening on :${config.port} | SMS mode: ${config.smsMode.toUpperCase()} ` +
        `(${container.provider.name}) | persistence: ${config.persistence}`,
    );
    if (config.smsMode === 'mock') {
      console.log('[server] LOCAL MOCK MODE - no SMS leaves this machine.');
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received - stopping tests and closing connections`);
    // Order matters: cancel schedulers, then drop sockets, then release storage.
    await container.testService.stopAll('SERVER_SHUTDOWN');
    await realtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await container.dispose();
    console.log('[server] shutdown complete');
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled rejection', reason);
  });
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`[config] ${error.message}`);
    process.exit(78); // EX_CONFIG
  }
  console.error('[server] fatal startup error', error);
  process.exit(1);
});
