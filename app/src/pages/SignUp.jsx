import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';
import AuthLayout from '../components/AuthLayout.jsx';

const PASSWORD_MIN = 8;

function strength(pw) {
  let s = 0;
  if (pw.length >= PASSWORD_MIN) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}
const STRENGTH_LABELS = ['', 'Weak', 'Okay', 'Strong', 'Excellent'];

export default function SignUp() {
  const navigate = useNavigate();
  const toast = useToast();
  const { signUp, isAuthed } = useAuth();

  useEffect(() => {
    if (isAuthed) navigate('/app', { replace: true });
  }, [isAuthed, navigate]);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const pwScore = strength(password);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const canSubmit = fullName.trim().length >= 2 && emailValid && password.length >= PASSWORD_MIN;

  const submit = async (e) => {
    e?.preventDefault();
    if (!canSubmit) {
      if (fullName.trim().length < 2) toast('Add your name.', { tone: 'warn' });
      else if (!emailValid) toast('Check the email format.', { tone: 'warn' });
      else if (password.length < PASSWORD_MIN) toast(`Password needs ${PASSWORD_MIN}+ characters.`, { tone: 'warn' });
      return;
    }
    setSubmitting(true);
    try {
      const result = await signUp({ email, password, fullName: fullName.trim() });
      if (!result.ok) {
        toast(result.error || 'Sign up failed.', { tone: 'danger' });
        return;
      }
      if (result.needsConfirmation) {
        toast('Check your email to confirm your account.', { tone: 'success' });
        navigate('/auth/check-email', { state: { email } });
        return;
      }
      toast(`Welcome, ${fullName.split(' ')[0]}.`, { tone: 'success' });
      navigate('/app');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      eyebrow="Start free"
      title="Get traffic, with receipts."
      lede="14 days free. No card. First article in 6 minutes."
      footer={
        <>
          Already have an account? <Link to="/sign-in">Sign in</Link>
        </>
      }
    >
      <form onSubmit={submit} className="auth-form">
        <label className="field">
          <span className="field-label">Your name</span>
          <input
            className="input"
            type="text"
            autoComplete="name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Maren Olsen"
            disabled={submitting}
          />
        </label>

        <label className="field">
          <span className="field-label">Work email</span>
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
          <span className="field-label">Password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={`At least ${PASSWORD_MIN} characters`}
            disabled={submitting}
          />
          {password && (
            <div className={`pw-strength pw-strength-${pwScore}`}>
              <div className="pw-strength-bar"><div /></div>
              <span>{STRENGTH_LABELS[pwScore] || 'Too short'}</span>
            </div>
          )}
        </label>

        <button
          type="submit"
          className="btn btn-primary btn-lg auth-submit"
          disabled={!canSubmit || submitting}
        >
          {submitting ? 'Creating account…' : 'Create account'}
        </button>

        <p className="auth-fineprint">
          By continuing you agree to the <Link to="/terms">Terms</Link> and <Link to="/privacy">Privacy Policy</Link>.
        </p>
      </form>
    </AuthLayout>
  );
}
