// User lands here from the password-reset email. Supabase puts a recovery
// session on window via detectSessionInUrl, so we can call updateUser
// directly once the auth provider has hydrated.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';
import AuthLayout from '../components/AuthLayout.jsx';

const PASSWORD_MIN = 8;

export default function ResetPassword() {
  const navigate = useNavigate();
  const toast = useToast();
  const { updatePassword, user, loading } = useAuth();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // If we land here without a recovery session, send them to forgot.
  useEffect(() => {
    if (!loading && !user) {
      toast('Reset link expired. Request a new one.', { tone: 'warn' });
      navigate('/forgot-password', { replace: true });
    }
  }, [loading, user, navigate, toast]);

  const canSubmit = password.length >= PASSWORD_MIN && password === confirm;

  const submit = async (e) => {
    e?.preventDefault();
    if (!canSubmit) {
      if (password !== confirm) toast("Passwords don't match.", { tone: 'warn' });
      else if (password.length < PASSWORD_MIN) toast(`Password needs ${PASSWORD_MIN}+ characters.`, { tone: 'warn' });
      return;
    }
    setSubmitting(true);
    try {
      const result = await updatePassword(password);
      if (!result.ok) {
        toast(result.error || 'Could not update password.', { tone: 'danger' });
        return;
      }
      toast('Password updated.', { tone: 'success' });
      navigate('/app', { replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      eyebrow="Set a new password"
      title="One last step."
      lede="Pick a strong password — 8+ characters."
      footer={<Link to="/sign-in">Cancel</Link>}
    >
      <form onSubmit={submit} className="auth-form">
        <label className="field">
          <span className="field-label">New password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="field">
          <span className="field-label">Confirm new password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={submitting}
          />
        </label>

        <button
          type="submit"
          className="btn btn-primary btn-lg auth-submit"
          disabled={!canSubmit || submitting}
        >
          {submitting ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </AuthLayout>
  );
}
