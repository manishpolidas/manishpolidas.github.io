import type { AppConfig } from '../../config.js';
import { MockSmsProvider } from './MockSmsProvider.js';
import { SandboxSmsProvider } from './SandboxSmsProvider.js';
import { AuthorizedSmsProvider } from './AuthorizedSmsProvider.js';
import type { SmsProvider } from './SmsProvider.js';

export { MockSmsProvider } from './MockSmsProvider.js';
export { SandboxSmsProvider } from './SandboxSmsProvider.js';
export { AuthorizedSmsProvider } from './AuthorizedSmsProvider.js';
export { HttpSmsProvider } from './HttpSmsProvider.js';
export * from './SmsProvider.js';

/** Composition root for the SMS transport. Defaults to the local simulator. */
export function createSmsProvider(config: AppConfig): SmsProvider {
  switch (config.smsMode) {
    case 'sandbox':
      return new SandboxSmsProvider({
        apiUrl: config.sandbox.apiUrl,
        apiKey: config.sandbox.apiKey,
        timeoutMs: config.sandbox.timeoutMs,
      });
    case 'authorized':
      return new AuthorizedSmsProvider({
        apiUrl: config.authorized.apiUrl,
        apiKey: config.authorized.apiKey,
        timeoutMs: config.authorized.timeoutMs,
      });
    case 'mock':
    default:
      return new MockSmsProvider({
        latencyMs: config.mock.latencyMs,
        jitterMs: config.mock.jitterMs,
        failureRate: config.mock.failureRate,
      });
  }
}
