// Billing settings — current plan + manage subscription button.
// Reads from public.subscriptions and public.profiles via RLS.

import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';
import { openCustomerPortal, PLANS } from '../lib/billing.js';

const Logo = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4 L8 12 L14 20" />
    <circle cx="14" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="14" cy="20" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

const ArrowRight = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 5l7 7-7 7" />
  </svg>
);

export default function Billing() {
  const { user, profile, signOut } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyPortal, setBusyPortal] = useState(false);

  // Reaching this page after Checkout: surface a friendly toast.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('checkout') === 'success') {
      toast('Subscription active. Welcome aboard.', { tone: 'success' });
      window.history.replaceState({}, '', '/app/billing');
    }
  }, [location.search, toast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isSupabaseConfigured || !user) {
        setLoading(false);
        return;
      }
      const { data } = await supabase
        .from('subscriptions')
        .select(
          'plan, status, current_period_end, cancel_at_period_end, articles_used_this_period, articles_quota'
        )
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) {
        setSubscription(data ?? null);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handlePortal = async () => {
    setBusyPortal(true);
    const result = await openCustomerPortal();
    if (!result.ok) {
      toast(result.error || 'Could not open billing portal.', { tone: 'danger' });
      setBusyPortal(false);
    }
  };

  const planMeta = PLANS.find((p) => p.id === (subscription?.plan ?? profile?.plan));
  const onFreePlan = !subscription || subscription.status !== 'active' && subscription?.status !== 'trialing';

  return (
    <div className="app-shell">
      <header className="app-nav">
        <div className="app-nav-inner">
          <Link to="/app" className="app-brand">
            <span className="brand-mark"><Logo /></span>
            <span className="brand-wm">bylined</span>
          </Link>
          <nav className="app-nav-links">
            <Link to="/app">Articles</Link>
            <Link to="/app/sites">Sites</Link>
            <Link to="/app/voice">Voice</Link>
            <Link to="/app/usage">Usage</Link>
            <Link to="/app/billing">Billing</Link>
          </nav>
          <div className="app-nav-user">
            <Link to="/app/settings" className="app-nav-email">{user?.email}</Link>
            <button type="button" className="btn btn-sm btn-ghost" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="app-container" style={{ maxWidth: 720 }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}>Billing</div>
          <h1 className="app-h1 serif" style={{ fontSize: 44 }}>
            Your plan
          </h1>

          {loading ? (
            <div className="app-callout">
              <div>Loading subscription…</div>
            </div>
          ) : onFreePlan ? (
            <div className="app-callout" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 16 }}>
              <div>
                <div className="eyebrow" style={{ marginBottom: 8 }}>Current plan</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--fg)' }}>Free</div>
                <p className="app-callout-p" style={{ marginTop: 8 }}>
                  Subscribe to a paid plan to unlock article generation and CMS publishing.
                </p>
              </div>
              <Link to="/app/pricing" className="btn btn-primary">
                See plans <ArrowRight />
              </Link>
            </div>
          ) : (
            <>
              <div className="app-callout" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 24, fontWeight: 600, color: 'var(--fg)' }}>
                    {planMeta?.name ?? subscription.plan}
                  </div>
                  <span className={`chip ${subscription.status === 'active' ? 'chip-faint' : 'chip-warn'}`}>
                    {subscription.status}
                  </span>
                  {subscription.cancel_at_period_end && (
                    <span className="chip chip-warn">Canceling at period end</span>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 24, width: '100%' }}>
                  <div>
                    <div className="eyebrow" style={{ marginBottom: 6 }}>This period</div>
                    <div className="mono" style={{ fontSize: 24, color: 'var(--fg)' }}>
                      {subscription.articles_used_this_period}{' '}
                      <span style={{ color: 'var(--fg-subtle)', fontSize: 14 }}>
                        / {subscription.articles_quota}
                      </span>
                    </div>
                    <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>articles used</div>
                  </div>
                  <div>
                    <div className="eyebrow" style={{ marginBottom: 6 }}>Renews</div>
                    <div style={{ fontSize: 14, color: 'var(--fg)' }}>
                      {new Date(subscription.current_period_end).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={handlePortal}
                  disabled={busyPortal}
                  style={{ marginTop: 8 }}
                >
                  {busyPortal ? 'Opening portal…' : 'Manage subscription'} {!busyPortal && <ArrowRight size={12} />}
                </button>
              </div>
              <p className="app-fineprint" style={{ marginTop: 24, fontSize: 12.5, color: 'var(--fg-subtle)' }}>
                Manage subscription opens Stripe's hosted Customer Portal — change plan,
                update card, view invoices, or cancel.
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
