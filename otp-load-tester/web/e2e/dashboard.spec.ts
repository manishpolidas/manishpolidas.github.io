import { expect, test, type Page } from '@playwright/test';

const CREDENTIALS = { username: 'admin', password: 'admin123' };

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-form').waitFor();
  await page.fill('#username', CREDENTIALS.username);
  await page.fill('#password', CREDENTIALS.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('mode-banner')).toContainText('LOCAL MOCK MODE');
}

async function configure(
  page: Page,
  options: {
    rate?: string;
    max?: string;
    duration?: string;
    recipient?: string;
    name?: string;
  } = {},
): Promise<void> {
  await page.fill('#recipient', options.recipient ?? 'TEST-USER-001');
  await page.fill('#messagesPerMinute', options.rate ?? '120');
  await page.fill('#maxMessages', options.max ?? '20');
  await page.fill('#durationSeconds', options.duration ?? '120');
  if (options.name) await page.fill('#testName', options.name);
}

test.describe('OTP test console', () => {
  test('rejects bad credentials', async ({ page }) => {
    await page.goto('/');
    await page.fill('#username', 'admin');
    await page.fill('#password', 'not-the-password');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toContainText('Invalid username or password');
  });

  test('blocks Start until the authorization confirmation is checked', async ({ page }) => {
    await signIn(page);
    await configure(page);
    await page.getByTestId('btn-start').click();
    await expect(page.getByTestId('error-authorization')).toBeVisible();
    await expect(page.getByTestId('stats-empty')).toBeVisible();
  });

  test('validates the recipient and the numeric limits', async ({ page }) => {
    await signIn(page);
    await page.getByTestId('input-authorization').check();
    await configure(page, { recipient: 'no' });
    await page.getByTestId('btn-start').click();
    await expect(page.locator('.error').first()).toContainText('E.164');

    await configure(page, { rate: '999999' });
    await page.getByTestId('btn-start').click();
    await expect(page.locator('.error').first()).toContainText('Messages per minute');
  });

  test('start -> live stats -> pause -> resume -> stop, with no activity after stop', async ({
    page,
  }) => {
    await signIn(page);
    await configure(page, { rate: '240', max: '100', duration: '120', name: 'e2e soak' });
    await page.getByTestId('input-authorization').check();

    // Start
    await page.getByTestId('btn-start').click();
    await expect(page.getByTestId('test-status')).toHaveText('RUNNING');
    await expect(page.getByTestId('btn-start')).toBeDisabled();
    await expect(page.getByTestId('btn-stop')).toBeEnabled();
    await expect(page.getByTestId('input-recipient')).toBeDisabled();

    // Real-time statistics and log
    await expect(page.getByTestId('stat-generated')).not.toHaveText('0');
    await expect(page.getByTestId('log-row').first()).toBeVisible();
    await expect(page.getByTestId('activity-log')).toContainText('otp.generated');
    await expect(page.getByTestId('activity-log')).toContainText('sms.simulated');

    // Pause
    await page.getByTestId('btn-pause').click();
    await expect(page.getByTestId('test-status')).toHaveText('PAUSED');
    const pausedCount = Number(await page.getByTestId('stat-generated').innerText());
    await page.waitForTimeout(1200);
    expect(Number(await page.getByTestId('stat-generated').innerText())).toBe(pausedCount);

    // Resume
    await page.getByTestId('btn-resume').click();
    await expect(page.getByTestId('test-status')).toHaveText('RUNNING');
    await expect
      .poll(async () => Number(await page.getByTestId('stat-generated').innerText()))
      .toBeGreaterThan(pausedCount);

    // Stop
    await page.getByTestId('btn-stop').click();
    await expect(page.getByTestId('test-status')).toHaveText('STOPPED');
    await expect(page.getByTestId('btn-stop')).toBeDisabled();
    await expect(page.getByTestId('btn-start')).toBeEnabled();

    const stoppedCount = Number(await page.getByTestId('stat-generated').innerText());
    await page.waitForTimeout(2000);
    expect(Number(await page.getByTestId('stat-generated').innerText())).toBe(stoppedCount);
    await expect(page.getByTestId('stop-reason')).toContainText('user stop');
  });

  test('completes on its own at the message cap and records history', async ({ page }) => {
    await signIn(page);
    await configure(page, { rate: '600', max: '5', duration: '60', name: 'e2e cap' });
    await page.getByTestId('input-authorization').check();
    await page.getByTestId('btn-start').click();

    await expect(page.getByTestId('test-status')).toHaveText('COMPLETED', { timeout: 20_000 });
    await expect(page.getByTestId('stat-generated')).toHaveText('5');
    await expect(page.getByTestId('stat-remaining')).toHaveText('0');

    const row = page.getByTestId('history-row').first();
    await expect(row).toContainText('e2e cap');

    // Open the stored detail view for the finished test.
    await row.getByRole('button', { name: 'e2e cap' }).click();
    await expect(page.getByTestId('test-detail')).toContainText('COMPLETED');
    await expect(page.getByTestId('test-detail')).toContainText('MAX_MESSAGES_REACHED');
    await page.getByTestId('btn-close-detail').click();
  });

  test('reset clears the current test view', async ({ page }) => {
    await signIn(page);
    await configure(page, { rate: '600', max: '3', duration: '30' });
    await page.getByTestId('input-authorization').check();
    await page.getByTestId('btn-start').click();
    await expect(page.getByTestId('test-status')).toHaveText('COMPLETED', { timeout: 20_000 });

    await page.getByTestId('btn-reset').click();
    await expect(page.getByTestId('stats-empty')).toBeVisible();
    await expect(page.getByTestId('input-authorization')).not.toBeChecked();
    await expect(page.getByTestId('history-row').first()).toBeVisible();
  });

  test('emergency stop halts a running test', async ({ page }) => {
    await signIn(page);
    await configure(page, { rate: '240', max: '200', duration: '300' });
    await page.getByTestId('input-authorization').check();
    await page.getByTestId('btn-start').click();
    await expect(page.getByTestId('test-status')).toHaveText('RUNNING');

    await page.getByTestId('btn-emergency-stop').click();
    await expect(page.getByTestId('test-status')).toHaveText('STOPPED');
  });
});
