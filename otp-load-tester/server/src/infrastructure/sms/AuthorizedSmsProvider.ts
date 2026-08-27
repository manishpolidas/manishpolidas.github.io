import type { SmsMode } from '../../domain/types.js';
import { HttpSmsProvider, type HttpSmsProviderOptions } from './HttpSmsProvider.js';

/**
 * Real delivery through an SMS gateway you control.
 *
 * Only usable when SMS_MODE=authorized AND the recipient appears in
 * RECIPIENT_ALLOWLIST (enforced by the test service before a run starts). It
 * exists so an owner can validate their own OTP system end to end; it is not a
 * way to send messages to arbitrary numbers.
 */
export class AuthorizedSmsProvider extends HttpSmsProvider {
  readonly name = 'authorized-sms-provider';
  readonly mode: SmsMode = 'authorized';

  constructor(options: HttpSmsProviderOptions) {
    super(options);
    console.warn(
      '[sms] AUTHORIZED SMS MODE is active: messages will be delivered for real. ' +
        'Only allowlisted recipients you own or are authorized to test can be targeted.',
    );
  }
}
