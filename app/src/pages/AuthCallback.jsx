// Landing page after a magic-link / email-confirmation redirect.
// Supabase's detectSessionInUrl picks up the hash params and the
// AuthProvider observes the auth state change. We just wait briefly
// then route based on the resulting session.

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import AuthLayout from '../components/AuthLayout.jsx';

const ALLOWED_PLANS = ['solo', 'studio', 'agency', 'scale'];
const PENDING_PLAN_KEY = 'bylined.pending_plan';

export default function AuthCallback() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    // Give Supabase a moment to finish hydrating from the URL hash.
    const t = setTimeout(() => {
      if (user) {
        // If the user came from a marketing-site CTA with a plan picked,
        // forward them straight to the matching pricing tier so they
        // can complete checkout without an extra hop.
        let plan = null;
        try {
          plan = localStorage.getItem(PENDING_PLAN_KEY);
          if (plan) localStorage.removeItem(PENDING_PLAN_KEY);
        } catch {
          /* ignore storage errors */
        }
        const dest =
          plan && ALLOWED_PLANS.includes(plan) ? `/app/pricing?plan=${plan}` : '/app';
        navigate(dest, { replace: true });
      } else {
        navigate('/sign-in?confirmed=1', { replace: true });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [loading, user, navigate]);

  return (
    <AuthLayout eyebrow="Confirming…" title="Almost there.">
      <p className="auth-lede">Signing you in.</p>
    </AuthLayout>
  );
}
