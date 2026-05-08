// Landing page after a magic-link / email-confirmation redirect.
// Supabase's detectSessionInUrl picks up the hash params and the
// AuthProvider observes the auth state change. We just wait briefly
// then route based on the resulting session.

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import AuthLayout from '../components/AuthLayout.jsx';

export default function AuthCallback() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    // Give Supabase a moment to finish hydrating from the URL hash.
    const t = setTimeout(() => {
      if (user) navigate('/app', { replace: true });
      else navigate('/sign-in?confirmed=1', { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [loading, user, navigate]);

  return (
    <AuthLayout eyebrow="Confirming…" title="Almost there.">
      <p className="auth-lede">Signing you in.</p>
    </AuthLayout>
  );
}
