import { useState, type FormEvent } from 'react';

export function LoginView({
  onSubmit,
  error,
}: {
  onSubmit: (username: string, password: string) => Promise<void>;
  error: string | null;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      await onSubmit(username, password);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="card login-card" onSubmit={submit} data-testid="login-form">
        <h1>OTP Test Console</h1>
        <p className="muted">
          Authorized OTP testing and load testing. Sign in to configure and run a test.
        </p>
        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {error ? (
          <p className="error" role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}
        <button className="primary" type="submit" disabled={busy} data-testid="login-submit">
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
