import type { PlatformConfig } from '../lib/types';

const MODE_COPY: Record<PlatformConfig['smsMode'], { label: string; detail: string }> = {
  mock: {
    label: 'LOCAL MOCK MODE',
    detail: 'OTPs are simulated locally. No SMS is sent and nothing leaves this machine.',
  },
  sandbox: {
    label: 'SANDBOX MODE',
    detail:
      'Requests go to a vendor sandbox endpoint that does not deliver to real handsets. ' +
      'Only allowlisted recipients can be targeted.',
  },
  authorized: {
    label: 'AUTHORIZED SMS MODE',
    detail:
      'Messages are delivered for real. Only recipients you own or are explicitly authorized ' +
      'to test are accepted, and every run is audit-logged.',
  },
};

export function SafetyBanner({ config }: { config: PlatformConfig }) {
  const copy = MODE_COPY[config.smsMode];
  return (
    <div className={`banner banner-${config.smsMode}`} data-testid="mode-banner">
      <div>
        <strong>{copy.label}</strong>
        <span className="muted"> - {copy.detail}</span>
      </div>
      <div className="banner-limits">
        <span>max {config.limits.maxMessagesPerMinute}/min</span>
        <span>max {config.limits.maxMessagesPerTest} msgs</span>
        <span>max {config.limits.maxDurationSeconds}s</span>
        <span>max {config.limits.maxConcurrentTests} concurrent</span>
      </div>
    </div>
  );
}
