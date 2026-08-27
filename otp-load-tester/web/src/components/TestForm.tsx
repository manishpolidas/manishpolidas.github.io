import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CreateTestInput } from '../lib/api';
import type { PlatformConfig, TestStatus } from '../lib/types';
import { isLive } from '../lib/types';

export interface TestFormProps {
  config: PlatformConfig;
  status: TestStatus | null;
  busy: string | null;
  canExecute: boolean;
  onStart: (input: CreateTestInput) => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
}

interface FormState {
  recipient: string;
  otpLength: string;
  messagesPerMinute: string;
  maxMessages: string;
  durationSeconds: string;
  testName: string;
}

function defaults(config: PlatformConfig): FormState {
  return {
    recipient: 'TEST-USER-001',
    otpLength: String(config.otpLength.default),
    messagesPerMinute: String(Math.min(10, config.limits.maxMessagesPerMinute)),
    maxMessages: String(Math.min(50, config.limits.maxMessagesPerTest)),
    durationSeconds: String(Math.min(300, config.limits.maxDurationSeconds)),
    testName: '',
  };
}

export function TestForm(props: TestFormProps) {
  const { config, status, busy, canExecute } = props;
  const [form, setForm] = useState<FormState>(() => defaults(config));
  const [acknowledged, setAcknowledged] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const live = isLive(status);
  const running = status === 'RUNNING';
  const paused = status === 'PAUSED';

  useEffect(() => {
    if (status === null) {
      setForm(defaults(config));
      setAcknowledged(false);
      setErrors({});
    }
  }, [status, config]);

  const projected = useMemo(() => {
    const rate = Number(form.messagesPerMinute);
    const duration = Number(form.durationSeconds);
    const max = Number(form.maxMessages);
    if (!rate || !duration || !max) return null;
    const byDuration = Math.floor((rate * duration) / 60);
    return Math.min(byDuration, max);
  }, [form.messagesPerMinute, form.durationSeconds, form.maxMessages]);

  const update = (field: keyof FormState) => (event: { target: { value: string } }) => {
    setForm((previous) => ({ ...previous, [field]: event.target.value }));
  };

  const validate = (): Record<string, string> => {
    const found: Record<string, string> = {};
    const recipientOk =
      /^\+?[1-9]\d{5,14}$/.test(form.recipient.trim()) ||
      /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(form.recipient.trim());
    if (!recipientOk) {
      found.recipient =
        'Use a phone number in E.164 form (+15551234567) or an id like TEST-USER-001.';
    }
    const numeric: [keyof FormState, number, number, string][] = [
      ['otpLength', config.otpLength.min, config.otpLength.max, 'OTP length'],
      ['messagesPerMinute', 1, config.limits.maxMessagesPerMinute, 'Messages per minute'],
      ['maxMessages', 1, config.limits.maxMessagesPerTest, 'Maximum messages'],
      ['durationSeconds', 1, config.limits.maxDurationSeconds, 'Test duration'],
    ];
    for (const [field, min, max, label] of numeric) {
      const value = Number(form[field]);
      if (!Number.isInteger(value) || value < min || value > max) {
        found[field] = `${label} must be a whole number between ${min} and ${max}.`;
      }
    }
    if (!acknowledged) {
      found.authorizationAcknowledged =
        'Confirm that you are authorized to test this recipient/system.';
    }
    return found;
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    props.onStart({
      recipient: form.recipient.trim(),
      otpLength: Number(form.otpLength),
      messagesPerMinute: Number(form.messagesPerMinute),
      maxMessages: Number(form.maxMessages),
      durationSeconds: Number(form.durationSeconds),
      testName: form.testName.trim() === '' ? null : form.testName.trim(),
      authorizationAcknowledged: true,
    });
  };

  return (
    <form className="card" onSubmit={submit} data-testid="test-form">
      <h2>Test configuration</h2>

      <div className="field">
        <label htmlFor="recipient">Test recipient / phone number</label>
        <input
          id="recipient"
          value={form.recipient}
          onChange={update('recipient')}
          disabled={live}
          data-testid="input-recipient"
        />
        {errors.recipient ? <span className="error">{errors.recipient}</span> : null}
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="otpLength">
            OTP length ({config.otpLength.min}-{config.otpLength.max})
          </label>
          <input
            id="otpLength"
            type="number"
            min={config.otpLength.min}
            max={config.otpLength.max}
            value={form.otpLength}
            onChange={update('otpLength')}
            disabled={live}
            data-testid="input-otp-length"
          />
          {errors.otpLength ? <span className="error">{errors.otpLength}</span> : null}
        </div>

        <div className="field">
          <label htmlFor="messagesPerMinute">Messages per minute</label>
          <input
            id="messagesPerMinute"
            type="number"
            min={1}
            max={config.limits.maxMessagesPerMinute}
            value={form.messagesPerMinute}
            onChange={update('messagesPerMinute')}
            disabled={live}
            data-testid="input-rate"
          />
          {errors.messagesPerMinute ? (
            <span className="error">{errors.messagesPerMinute}</span>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="maxMessages">Maximum messages</label>
          <input
            id="maxMessages"
            type="number"
            min={1}
            max={config.limits.maxMessagesPerTest}
            value={form.maxMessages}
            onChange={update('maxMessages')}
            disabled={live}
            data-testid="input-max-messages"
          />
          {errors.maxMessages ? <span className="error">{errors.maxMessages}</span> : null}
        </div>

        <div className="field">
          <label htmlFor="durationSeconds">Test duration (seconds)</label>
          <input
            id="durationSeconds"
            type="number"
            min={1}
            max={config.limits.maxDurationSeconds}
            value={form.durationSeconds}
            onChange={update('durationSeconds')}
            disabled={live}
            data-testid="input-duration"
          />
          {errors.durationSeconds ? <span className="error">{errors.durationSeconds}</span> : null}
        </div>
      </div>

      <div className="field">
        <label htmlFor="testName">Test name (optional)</label>
        <input
          id="testName"
          value={form.testName}
          onChange={update('testName')}
          disabled={live}
          placeholder="e.g. login OTP - 10/min soak"
          data-testid="input-test-name"
        />
      </div>

      {projected !== null ? (
        <p className="muted" data-testid="projection">
          This configuration will generate up to <strong>{projected}</strong> OTP requests.
        </p>
      ) : null}

      <label className="checkbox">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          disabled={live}
          data-testid="input-authorization"
        />
        <span>I confirm that I am authorized to test this recipient/system.</span>
      </label>
      {errors.authorizationAcknowledged ? (
        <span className="error" data-testid="error-authorization">
          {errors.authorizationAcknowledged}
        </span>
      ) : null}

      <div className="controls">
        <button
          className="primary"
          type="submit"
          disabled={live || busy !== null || !canExecute}
          data-testid="btn-start"
        >
          {busy === 'start' ? 'Starting...' : 'Start Test'}
        </button>
        <button
          className="danger"
          type="button"
          onClick={props.onStop}
          disabled={!live || busy !== null}
          data-testid="btn-stop"
        >
          {busy === 'stop' ? 'Stopping...' : 'Stop Test'}
        </button>
        <button
          type="button"
          onClick={props.onPause}
          disabled={!running || busy !== null}
          data-testid="btn-pause"
        >
          Pause
        </button>
        <button
          type="button"
          onClick={props.onResume}
          disabled={!paused || busy !== null}
          data-testid="btn-resume"
        >
          Resume
        </button>
        <button
          type="button"
          onClick={props.onReset}
          disabled={live || busy !== null}
          data-testid="btn-reset"
        >
          Reset
        </button>
      </div>
      {!canExecute ? (
        <p className="muted">Your account is read-only; test execution requires the admin role.</p>
      ) : null}
    </form>
  );
}
