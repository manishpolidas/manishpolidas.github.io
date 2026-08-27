import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;
const API_PORT = 4000;

/**
 * Boots the API in LOCAL MOCK MODE plus the Vite dev server, then drives the
 * dashboard in a real browser.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'npm run dev --workspace=server',
      cwd: '..',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        SESSION_SECRET: 'e2e-session-secret-e2e-session-secret-0123',
        OTP_HASH_PEPPER: 'e2e-pepper',
        DASHBOARD_USERNAME: 'admin',
        DASHBOARD_PASSWORD: 'admin123',
        SMS_MODE: 'mock',
        MOCK_LATENCY_MS: '10',
        MOCK_LATENCY_JITTER_MS: '10',
        MOCK_FAILURE_RATE: '0.2',
        MAX_MESSAGES_PER_MINUTE: '600',
        MAX_MESSAGES_PER_TEST: '500',
        MAX_DURATION_SECONDS: '600',
        API_RATE_LIMIT_PER_MINUTE: '10000',
        PERSISTENCE: 'memory',
      },
    },
    {
      command: 'npm run dev',
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
