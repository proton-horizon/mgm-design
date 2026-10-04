import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { request } from './api';
import { useDialog } from './useDialog';

function PasswordForm({ token, onSuccess }: { token?: string; onSuccess: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="password-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError('');
        if (data.get('password') !== data.get('confirmPassword')) {
          setError('The new passwords do not match.');
          return;
        }
        setBusy(true);
        try {
          await request(token ? '/api/account-link/accept' : '/api/account/password', {
            method: 'POST',
            body: JSON.stringify({
              token,
              currentPassword: data.get('currentPassword'),
              password: data.get('password'),
            }),
          });
          onSuccess();
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {!token && (
        <label>
          Current password
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            maxLength={256}
            required
          />
        </label>
      )}
      <label>
        New password
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={256}
          placeholder="At least 12 characters"
          required
        />
      </label>
      <label>
        Confirm new password
        <input
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={256}
          required
        />
      </label>
      <p className="hint">
        You’ll sign in with your new password. Existing sessions will be signed out.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary-button" disabled={busy}>
        {busy ? 'Saving…' : 'Save password'}
      </button>
    </form>
  );
}

export function AccountAccess({ token, done }: { token: string; done: () => void }) {
  const [details, setDetails] = useState<{
    kind: string;
    email: string;
    name: string;
    role: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void request<NonNullable<typeof details>>('/api/account-link', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then((data) => {
        if (active) setDetails(data);
      })
      .catch((error: Error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [token]);
  return (
    <div className="signin-page">
      <main className="signin-card">
        <span className="eyebrow">MGM DESIGN</span>
        <h1>
          {saved
            ? 'Your password is ready.'
            : details?.kind === 'invite'
              ? 'You’re invited.'
              : 'Choose your password.'}
        </h1>
        {saved ? (
          <>
            <p>Sign in as {details?.email} with your new password.</p>
            <button className="primary-button" onClick={done}>
              Continue to sign in
            </button>
          </>
        ) : error ? (
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <button className="plain-button" onClick={done}>
              Back to workspace
            </button>
          </>
        ) : details ? (
          <>
            <p>
              {details.name} · {details.email}
              <br />
              {details.role === 'admin' ? 'Site admin' : 'Viewer'} · {location.host}
            </p>
            <PasswordForm token={token} onSuccess={() => setSaved(true)} />
            <button className="plain-button" onClick={done}>
              Cancel
            </button>
          </>
        ) : (
          <p role="status">Checking your link…</p>
        )}
      </main>
    </div>
  );
}

export function ChangePassword({ close, onSuccess }: { close: () => void; onSuccess: () => void }) {
  const dialog = useDialog();
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        ref={dialog}
        className="modal password-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Change password"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      >
        <div className="modal-heading">
          <h2>Change password</h2>
          <button className="icon-button" aria-label="Close password settings" onClick={close}>
            <X size={20} />
          </button>
        </div>
        <PasswordForm onSuccess={onSuccess} />
      </section>
    </div>
  );
}
