// Landing page after a magic-link / email-confirmation redirect.
// Supabase's detectSessionInUrl picks up the hash params and the
// AuthProvider observes the auth state change. We just wait briefly
// then route based on the resulting session.
//
// Plan handling: if the user came from a marketing CTA with ?plan=…
//   - 'pilot' → call the start-pilot edge function to create a free
//      14-day subscription, then land on /app
//   - 'studio' | 'agency' | 'scale' → forward to /app/pricing?plan=…
//      so they can complete Stripe checkout
//   - 'solo' is legacy: existing customers stay on it, but new
//      signups via /sign-up?plan=solo are remapped to /app/pricing
//      (we don't want fresh signups picking the deprecated tier)

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { invokeEdgeFunction } from '../lib/stripe.js';
import AuthLayout from '../components/AuthLayout.jsx';

const PAID_PLANS = ['studio', 'agency', 'scale'];
const PENDING_PLAN_KEY = 'bylined.pending_plan';

export default function AuthCallback() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    // Give Supabase a moment to finish hydrating from the URL hash.
    const t = setTimeout(async () => {
      if (!user) {
        navigate('/sign-in?confirmed=1', { replace: true });
        return;
      }

      let plan = null;
      try {
        plan = localStorage.getItem(PENDING_PLAN_KEY);
        if (plan) localStorage.removeItem(PENDING_PLAN_KEY);
      } catch {
        /* ignore storage errors */
      }

      if (plan === 'pilot') {
        // Fire-and-forget the trial creation; idempotent on the server.
        // Don't block routing on it — worst case the user lands on /app
        // without an active sub and the in-app banner prompts them.
        invokeEdgeFunction('start-pilot', {}).catch(() => {});
        navigate('/app?pilot=started', { replace: true });
        return;
      }

      if (plan && PAID_PLANS.includes(plan)) {
        navigate(`/app/pricing?plan=${plan}`, { replace: true });
        return;
      }

      navigate('/app', { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [loading, user, navigate]);

  return (
    <AuthLayout eyebrow="Confirming…" title="Almost there.">
      <p className="auth-lede">Signing you in.</p>
    </AuthLayout>
  );
}
