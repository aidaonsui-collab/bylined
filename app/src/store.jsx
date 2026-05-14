import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase, isSupabaseConfigured } from './lib/supabase.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  // Subscribe to Supabase auth state. Set the user from the JWT
  // synchronously, then defer any DB queries with setTimeout(0) so they
  // run OUTSIDE the auth callback's stack frame. supabase-js docs warn
  // that calling .from().select() / .rpc() inside onAuthStateChange can
  // deadlock against the auth client's getSession() lock — glossi hit
  // this in production.
  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    const fetchProfile = async (session) => {
      if (cancelled) return;
      const { data } = await supabase
        .from('profiles')
        .select('id, email, full_name, plan, created_at')
        .eq('id', session.user.id)
        .maybeSingle();
      if (!cancelled) setProfile(data ?? null);
    };

    const handle = (session) => {
      if (cancelled) return;
      if (!session?.user) {
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }
      // Show the user immediately from the JWT — don't block on the
      // profile fetch.
      setUser(session.user);
      setLoading(false);
      // Defer profile fetch to escape the auth callback's stack frame.
      setTimeout(() => {
        fetchProfile(session);
      }, 0);
    };

    supabase.auth.getSession().then(({ data }) => handle(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => handle(session));

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signUp = useCallback(async ({ email, password, fullName }) => {
    if (!isSupabaseConfigured) {
      return { ok: false, error: 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local.' };
    }
    if (!password || password.length < 8) {
      return { ok: false, error: 'Password must be at least 8 characters.' };
    }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) return { ok: false, error: error.message };
    return {
      ok: true,
      // Supabase returns user but no session if email confirmation is on.
      needsConfirmation: !data.session,
      data,
    };
  }, []);

  const signIn = useCallback(async ({ email, password }) => {
    if (!isSupabaseConfigured) {
      return { ok: false, error: 'Supabase is not configured.' };
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }, []);

  const signOut = useCallback(async () => {
    if (!isSupabaseConfigured) return { ok: true };
    const { error } = await supabase.auth.signOut();
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }, []);

  const requestPasswordReset = useCallback(async (email) => {
    if (!isSupabaseConfigured) {
      return { ok: false, error: 'Supabase is not configured.' };
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset`,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }, []);

  const updatePassword = useCallback(async (password) => {
    if (!isSupabaseConfigured) return { ok: false, error: 'Supabase not configured.' };
    if (!password || password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }, []);

  // Update editable profile fields (just full_name today). RLS policy
  // update_own_profile permits this; plan + stripe_customer_id stay
  // server-managed. We patch local state on success so the nav etc.
  // reflect the change without a reload.
  const updateProfile = useCallback(
    async (fields) => {
      if (!isSupabaseConfigured) return { ok: false, error: 'Supabase not configured.' };
      if (!user) return { ok: false, error: 'Not signed in.' };
      const patch = {};
      if (typeof fields.full_name === 'string') {
        patch.full_name = fields.full_name.trim();
      }
      if (Object.keys(patch).length === 0) return { ok: true };
      const { data, error } = await supabase
        .from('profiles')
        .update(patch)
        .eq('id', user.id)
        .select('id, email, full_name, plan, created_at')
        .single();
      if (error) return { ok: false, error: error.message };
      setProfile(data);
      return { ok: true };
    },
    [user]
  );

  const value = {
    user,
    profile,
    loading,
    isAuthed: Boolean(user),
    signUp,
    signIn,
    signOut,
    requestPasswordReset,
    updatePassword,
    updateProfile,
  };

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
