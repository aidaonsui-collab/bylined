import { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';
import AuthLayout from '../components/AuthLayout.jsx';
import SocialAuth from '../components/SocialAuth.jsx';

export default function SignIn() {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { signIn, isAuthed } = useAuth();

  const from = location.state?.from?.pathname || '/app';

  useEffect(() => {
    if (isAuthed) navigate(from, { replace: true });
  }, [isAuthed, navigate, from]);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const canSubmit = emailValid && password.length > 0;

  const submit = async (e) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const result = await signIn({ email, password });
      if (!result.ok) {
        toast(result.error || 'Could not sign in.', { tone: 'danger' });
        return;
      }
      navigate(from, { replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      eyebrow="Welcome back"
      title="Sign in to Bylined."
      footer={
        <>
          New here? <Link to="/sign-up">Create an account</Link>
        </>
      }
    >
      <SocialAuth verb="Sign in" />

      <form onSubmit={submit} className="auth-form">
        <label className="field">
          <span className="field-label">Email</span>
          <input
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            disabled={submitting}
          />
        </label>

        <label className="field">
          <span className="field-label">
            Password
            <Link to="/forgot-password" className="field-label-action">Forgot?</Link>
          </span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </label>

        <button
          type="submit"
          className="btn btn-primary btn-lg auth-submit"
          disabled={!canSubmit || submitting}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthLayout>
  );
}
