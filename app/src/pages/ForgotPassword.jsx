import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';
import AuthLayout from '../components/AuthLayout.jsx';

export default function ForgotPassword() {
  const { requestPasswordReset } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const submit = async (e) => {
    e?.preventDefault();
    if (!emailValid) {
      toast('Check the email format.', { tone: 'warn' });
      return;
    }
    setSubmitting(true);
    try {
      const result = await requestPasswordReset(email);
      if (!result.ok) {
        toast(result.error || 'Could not send reset email.', { tone: 'danger' });
        return;
      }
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout
        eyebrow="Check your inbox"
        title="Reset link sent."
        lede={`If an account exists for ${email}, you'll get a reset link there in the next minute or two.`}
        footer={<Link to="/sign-in">Back to sign in</Link>}
      >
        <p className="auth-fineprint">
          Didn't get it? Check spam, or <Link to="/forgot-password" onClick={() => setSent(false)}>try a different email</Link>.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      eyebrow="Password reset"
      title="Forgot your password?"
      lede="We'll send you a one-time link to set a new one."
      footer={<Link to="/sign-in">Back to sign in</Link>}
    >
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

        <button
          type="submit"
          className="btn btn-primary btn-lg auth-submit"
          disabled={!emailValid || submitting}
        >
          {submitting ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
    </AuthLayout>
  );
}
