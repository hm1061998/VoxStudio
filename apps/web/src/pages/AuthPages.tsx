import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, describeError } from '../api/client';
import { useAuth } from '../app/auth';
import { ErrorNote, LanguageSelect } from '../components/ui';
import { useI18n } from '../i18n';

function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  const { t } = useI18n();
  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-3 flex justify-end">
          <LanguageSelect />
        </div>
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold">VoxStudio</h1>
          <p className="mt-1 text-sm text-muted">{t('app.tagline')}</p>
        </div>
        <div className="card p-6">
          <h2 className="mb-4 text-base font-semibold">{title}</h2>
          {children}
        </div>
        <p className="mt-4 text-center text-sm text-muted">{footer}</p>
      </div>
    </main>
  );
}

export function LoginPage() {
  const { signIn } = useAuth();
  const { t } = useI18n();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      nav('/');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard
      title={t('auth.signIn')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link className="text-accent underline underline-offset-2" to="/register">
            {t('auth.createOne')}
          </Link>{' '}
          ·{' '}
          <Link className="text-accent underline underline-offset-2" to="/reset">
            {t('auth.resetPassword')}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label" htmlFor="email">
            {t('auth.email')}
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            {t('auth.password')}
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <ErrorNote error={error} />}
        <button className="btn btn-primary w-full" disabled={busy}>
          {busy ? t('auth.signingIn') : t('auth.signIn')}
        </button>
      </form>
    </AuthCard>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const { t } = useI18n();
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: '', displayName: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Self-registration can be closed by the operator (ALLOW_REGISTRATION=false); say so instead of offering a dead form.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    api<{ registrationOpen: boolean }>('/auth/config')
      .then((c) => setOpen(c.registrationOpen))
      .catch(() => undefined);
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.password.length < 10) return setError(t('auth.passwordTooShort'));
    setBusy(true);
    setError(null);
    try {
      await register(f.email, f.password, f.displayName);
      nav('/');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard
      title={t('auth.createAccount')}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link className="text-accent underline underline-offset-2" to="/login">
            {t('auth.signIn')}
          </Link>
        </>
      }
    >
      {!open && (
        <p role="status" className="rounded-md border border-line bg-panel-2 p-3 text-sm text-muted">
          {t('auth.registrationClosed')}
        </p>
      )}
      <form onSubmit={submit} className="space-y-3" hidden={!open}>
        <div>
          <label className="label" htmlFor="name">
            {t('auth.displayName')}
          </label>
          <input
            id="name"
            className="input"
            required
            maxLength={80}
            value={f.displayName}
            onChange={(e) => setF({ ...f, displayName: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="email">
            {t('auth.email')}
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            {t('auth.passwordMin')}
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={f.password}
            onChange={(e) => setF({ ...f, password: e.target.value })}
          />
        </div>
        {error && <ErrorNote error={error} />}
        <button className="btn btn-primary w-full" disabled={busy}>
          {busy ? t('auth.creating') : t('auth.createAccount')}
        </button>
      </form>
    </AuthCard>
  );
}

export function ResetPage() {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('busy');
    setError(null);
    try {
      await api('/auth/password-reset/confirm', {
        method: 'POST',
        body: { token: token.trim(), newPassword: password },
      });
      setState('done');
    } catch (err) {
      setError(describeError(err));
      setState('idle');
    }
  };
  return (
    <AuthCard
      title={t('auth.resetTitle')}
      footer={
        <Link className="text-accent underline underline-offset-2" to="/login">
          {t('auth.backToSignIn')}
        </Link>
      }
    >
      {state === 'done' ? (
        <p role="status" className="text-sm text-ok">
          {t('auth.resetDone')}
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-muted">{t('auth.resetExplain')}</p>
          <div>
            <label className="label" htmlFor="code">
              {t('auth.resetCode')}
            </label>
            <input
              id="code"
              className="input font-mono"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="pw">
              {t('auth.newPassword')}
            </label>
            <input
              id="pw"
              className="input"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <ErrorNote error={error} />}
          <button className="btn btn-primary w-full" disabled={state === 'busy'}>
            {t('auth.setNewPassword')}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
