import type { SmsMode } from '../../domain/types.js';
import { HttpSmsProvider } from './HttpSmsProvider.js';

/**
 * Talks to a vendor sandbox / test endpoint. Sandbox endpoints acknowledge
 * messages without delivering them to real handsets, so this mode is safe for
 * integration testing but still requires an allowlisted recipient.
 */
export class SandboxSmsProvider extends HttpSmsProvider {
  readonly name = 'sandbox-sms-provider';
  readonly mode: SmsMode = 'sandbox';
}
