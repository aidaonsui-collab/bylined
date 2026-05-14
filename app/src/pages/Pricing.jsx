// In-app pricing page. Visually mirrors the marketing site's pricing
// rail (cream paper aesthetic + Studio featured tier) but the buttons
// here actually create Stripe Checkout sessions.

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';
import { PLANS, startCheckout } from '../lib/billing.js';

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

export default function Pricing() {
  const { user, profile, signOut } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [busy, setBusy] = useState(null); // plan id currently submitting
  const cardRefs = useRef({}); // plan.id → DOM node

  // ?plan=<id> from a marketing CTA — highlight + scroll the tier
  // into view so the user sees the right one immediately.
  const highlight = searchParams.get('plan');
  useEffect(() => {
    if (!highlight) return;
    const node = cardRefs.current[highlight];
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlight]);

  // If we got bounced back here from a cancelled Checkout, surface a toast.
  const cancelled = new URLSearchParams(location.search).get('checkout') === 'cancelled';
  if (cancelled) {
    setTimeout(() => toast('Checkout cancelled. No charge.', { tone: 'warn' }), 0);
    window.history.replaceState({}, '', '/app/pricing');
  }

  const handleSubscribe = async (plan) => {
    setBusy(plan.id);
    const result = await startCheckout(plan.priceId, plan.id);
    if (!result.ok) {
      toast(result.error || 'Could not start checkout.', { tone: 'danger' });
      setBusy(null);
    }
    // On success the browser navigates away — no need to clear busy.
  };

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
        <div className="app-container">
          <div className="eyebrow" style={{ marginBottom: 14 }}>Pricing</div>
          <h1 className="app-h1 serif">Pick by volume.</h1>
          <p className="app-lede">
            Receipts, AEO media, brand voice, and CMS publishing on every tier. The only thing
            that changes is how many articles you ship.
          </p>

          <div className="pr-grid" style={{ marginTop: 24 }}>
            {PLANS.map((plan) => {
              const isCurrent = profile?.plan === plan.id;
              const isLoading = busy === plan.id;
              const isHighlighted = highlight === plan.id;
              return (
                <div
                  key={plan.id}
                  ref={(node) => { cardRefs.current[plan.id] = node; }}
                  className={`pr-card ${plan.featured ? 'is-featured' : ''}`}
                  style={
                    isHighlighted
                      ? { boxShadow: '0 0 0 2px var(--accent-ring), var(--shadow-pop)' }
                      : undefined
                  }
                >
                  {plan.featured && <div className="pr-flag">Most picked</div>}
                  <div className="pr-name">{plan.name}</div>
                  <div className="pr-price">
                    <span className="mono">${plan.priceMonthly}</span>
                    <span className="pr-per">/month</span>
                  </div>
                  <div className="pr-d">{plan.description}</div>
                  <div className="pr-a">{plan.tagline}</div>
                  {isCurrent ? (
                    <div className="btn" style={{ marginTop: 18, opacity: 0.6, cursor: 'default' }}>
                      Current plan
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleSubscribe(plan)}
                      disabled={isLoading}
                      className={`btn ${plan.featured ? 'btn-primary' : ''}`}
                      style={{ marginTop: 18 }}
                    >
                      {isLoading ? 'Redirecting…' : `Subscribe to ${plan.name}`}{' '}
                      {!isLoading && <ArrowRight size={12} />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <p className="app-fineprint" style={{ marginTop: 32, fontSize: 12.5, color: 'var(--fg-subtle)' }}>
            Test mode — no real charges. Use Stripe test card{' '}
            <span className="mono">4242 4242 4242 4242</span> with any future date and CVC.
          </p>
        </div>
      </main>
    </div>
  );
}
