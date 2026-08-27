/** Cancellation-aware timing helpers shared by the scheduler and providers. */

export class CancelledError extends Error {
  constructor(message = 'Operation cancelled.') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function isCancellation(error: unknown): boolean {
  if (error instanceof CancelledError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
}

/**
 * Sleeps for `ms`, resolving early - by rejecting with `CancelledError` - as
 * soon as `signal` aborts. The timer is always cleared, so a cancelled sleep
 * never keeps the event loop alive.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CancelledError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));

    function onAbort() {
      clearTimeout(timer);
      reject(new CancelledError());
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Formats a millisecond duration as HH:MM:SS. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

export function nowIso(): string {
  return new Date().toISOString();
}
