// Billing settings — current plan + manage subscription button.
// Reads from public.subscriptions and public.profiles via RLS.

import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import AppNav from '../components/AppNav.jsx';
import { useToast } from '../components/Toast.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';
import { openCustomerPortal, startCheckout, PLANS } from '../lib/billing.js';

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
  // Per-tier button busy state so a slow Stripe checkout doesn't
  // freeze the whole grid — only the tier the user clicked.
  const [busyTierId, setBusyTierId] = useState(null);

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

  // Upgrade = new Stripe Checkout (lets us collect card if needed,
  // and Stripe handles the proration on existing subs). Downgrade =
  // route through the Customer Portal where Stripe shows the user
  // the proration credit on their next invoice before they confirm —
  // a better UX than doing the swap silently.
  const handleTierAction = async (tier, mode) => {
    if (!tier.priceId) return; // Pilot is not directly purchasable
    setBusyTierId(tier.id);
    if (mode === 'downgrade') {
      const result = await openCustomerPortal();
      if (!result.ok) toast(result.error || 'Could not open portal.', { tone: 'danger' });
    } else {
      const result = await startCheckout(tier.priceId, tier.id);
      if (!result.ok) toast(result.error || 'Checkout failed.', { tone: 'danger' });
    }
    setBusyTierId(null);
  };

  const planMeta = PLANS.find((p) => p.id === (subscription?.plan ?? profile?.plan));
  const onFreePlan = !subscription || subscription.status !== 'active' && subscription?.status !== 'trialing';
  // Resolve the user's current rank for the upgrade/downgrade math.
  // Treat no-active-sub as rank -1 so every paid tier is shown as an
  // "Upgrade" rather than a "Subscribe" (matches what marketing
  // already says — they signed up, they should upgrade).
  const currentRank = planMeta?.rank ?? -1;

  return (
    <div className="app-shell">
      <AppNav />

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

          {/* ─── Plan comparison + upgrade/downgrade ─────────────
              Mirrors the marketing /pricing personas so customers
              get the same framing inside the app. Upgrades create a
              new Stripe Checkout. Downgrades route to the Customer
              Portal where Stripe shows the proration credit. */}
          {!loading && (
            <div style={{ marginTop: 40 }}>
              <div className="eyebrow" style={{ marginBottom: 14 }}>
                {onFreePlan ? 'Compare plans' : 'Switch plans'}
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: 12,
                }}
              >
                {PLANS.map((tier) => {
                  const isCurrent = tier.id === (subscription?.plan ?? profile?.plan);
                  const isFreeTrial = tier.id === 'pilot';
                  const mode = tier.rank > currentRank ? 'upgrade' : tier.rank < currentRank ? 'downgrade' : 'current';
                  const ctaLabel = isCurrent
                    ? 'Current plan'
                    : isFreeTrial
                    ? onFreePlan
                      ? 'Trial only — sign up flow'
                      : 'Trial only'
                    : mode === 'upgrade'
                    ? onFreePlan
                      ? `Subscribe to ${tier.name}`
                      : `Upgrade to ${tier.name}`
                    : `Downgrade to ${tier.name}`;
                  const ctaDisabled =
                    busyTierId === tier.id ||
                    isCurrent ||
                    (isFreeTrial && !onFreePlan) ||
                    (isFreeTrial && onFreePlan);
                  return (
                    <div
                      key={tier.id}
                      className={`app-tile ${tier.featured ? 'pr-card is-featured' : ''}`}
                      style={{
                        padding: 18,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        border: isCurrent ? '1px solid var(--accent)' : undefined,
                        boxShadow: isCurrent ? '0 0 0 3px var(--accent-faint)' : undefined,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <div style={{ fontWeight: 600, color: 'var(--fg)', fontSize: 15 }}>{tier.name}</div>
                        {isCurrent && (
                          <span className="chip chip-accent" style={{ fontSize: 10, height: 18 }}>Current</span>
                        )}
                        {!isCurrent && tier.featured && (
                          <span className="chip chip-faint" style={{ fontSize: 10, height: 18 }}>Most picked</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                        <span className="mono" style={{ fontSize: 26, color: 'var(--fg)', fontWeight: 600, letterSpacing: '-0.02em' }}>
                          {tier.priceLabel}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{tier.pricePer}</span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 500 }}>
                        {tier.description}
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.4, minHeight: 36 }}>
                        {tier.persona}
                      </div>
                      {tier.delta && tier.id !== 'pilot' && (
                        <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', lineHeight: 1.4, marginTop: 2 }}>
                          {tier.delta}
                        </div>
                      )}
                      <button
                        type="button"
                        className={`btn btn-sm ${isCurrent || isFreeTrial ? 'btn-ghost' : mode === 'upgrade' ? 'btn-primary' : ''}`}
                        onClick={() => handleTierAction(tier, mode)}
                        disabled={ctaDisabled}
                        style={{ marginTop: 'auto', alignSelf: 'flex-start' }}
                      >
                        {busyTierId === tier.id ? 'Opening…' : ctaLabel}
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="app-fineprint" style={{ marginTop: 16, fontSize: 12, color: 'var(--fg-subtle)' }}>
                Upgrades take effect immediately and Stripe pro-rates the difference. Downgrades
                open the customer portal so you can see the proration credit before confirming.
                Full feature comparison on the <Link to="/app/pricing">pricing page</Link>.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
