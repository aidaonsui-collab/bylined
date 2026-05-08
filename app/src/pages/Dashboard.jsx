// Phase 1 placeholder dashboard — confirms auth works end-to-end and
// gives a landing surface to navigate into. Future phases will fill
// this with the article queue, generate flow, settings, billing, etc.

import { Link } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';

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

export default function Dashboard() {
  const { user, profile, signOut } = useAuth();
  const toast = useToast();

  const handleSignOut = async () => {
    const result = await signOut();
    if (!result.ok) toast(result.error || 'Could not sign out.', { tone: 'danger' });
  };

  const displayName =
    profile?.full_name ||
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'there';

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
            <Link to="/app/billing">Billing</Link>
          </nav>
          <div className="app-nav-user">
            <span className="app-nav-email">{user?.email}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="app-container">
          <div className="eyebrow" style={{ marginBottom: 14 }}>Dashboard</div>
          <h1 className="app-h1 serif">
            Welcome, <span className="hero-h1-em">{displayName.split(' ')[0]}</span>.
          </h1>
          <p className="app-lede">
            You're signed in. The product surfaces below are placeholders — Phase 2 wires them up to the engine.
          </p>

          <div className="app-tile-grid">
            <div className="app-tile">
              <div className="app-tile-eyebrow mono">01</div>
              <h3 className="app-tile-h">Connect a site</h3>
              <p className="app-tile-p">
                Link WordPress, Webflow, Shopify, Ghost, Notion, or a webhook so Bylined can publish for you.
              </p>
              <span className="app-tile-status">Coming in Phase 4</span>
            </div>
            <div className="app-tile">
              <div className="app-tile-eyebrow mono">02</div>
              <h3 className="app-tile-h">Set your brand voice</h3>
              <p className="app-tile-p">
                Drop a homepage URL and Bylined ingests your existing pages to match your tone.
              </p>
              <span className="app-tile-status">Coming in Phase 4</span>
            </div>
            <div className="app-tile">
              <div className="app-tile-eyebrow mono">03</div>
              <h3 className="app-tile-h">Generate your first article</h3>
              <p className="app-tile-p">
                Type a topic. Bylined drafts it sourced, scored, and ready to publish.
              </p>
              <span className="app-tile-status">Coming in Phase 4</span>
            </div>
          </div>

          <div className="app-callout">
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Phase 1 — what's wired</div>
              <p className="app-callout-p">
                Auth (signup / sign-in / password reset / email confirmation) is live. Visit the marketing site or sign out to try the loop.
              </p>
            </div>
            <a className="btn" href="/" style={{ marginLeft: 'auto' }}>
              Marketing site <ArrowRight />
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
