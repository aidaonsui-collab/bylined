import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../store.jsx';

const Logo = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4 L8 12 L14 20" />
    <circle cx="14" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="14" cy="20" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

const NAV_LINKS = [
  { to: '/app', label: 'Articles', exact: true },
  { to: '/app/sites', label: 'Sites' },
  { to: '/app/voice', label: 'Voice' },
  { to: '/app/usage', label: 'Usage' },
  { to: '/app/billing', label: 'Billing' },
];

export default function AppNav({ activeSub }) {
  const { user, signOut } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <header className="app-nav">
      <div className="app-nav-inner">
        <Link to="/app" className="app-brand">
          <span className="brand-mark"><Logo /></span>
          <span className="brand-wm">bylined</span>
        </Link>

        <nav className="app-nav-links">
          {NAV_LINKS.map((l) => (
            <Link key={l.to} to={l.to}>{l.label}</Link>
          ))}
        </nav>

        <div className="app-nav-user">
          {activeSub && (
            <span className="mono app-nav-usage" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {activeSub.articles_used_this_period}/{activeSub.articles_quota} this period
            </span>
          )}
          <Link to="/app/settings" className="app-nav-email">{user?.email}</Link>
          <button type="button" className="btn btn-sm btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>

        <button
          type="button"
          className={`app-nav-burger ${open ? 'is-open' : ''}`}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="app-nav-panel"
          onClick={() => setOpen((v) => !v)}
        >
          <span /><span /><span />
        </button>
      </div>

      <div
        id="app-nav-panel"
        className={`app-nav-panel ${open ? 'is-open' : ''}`}
        role="dialog"
        aria-modal="true"
        hidden={!open}
      >
        {activeSub && (
          <div className="app-nav-panel-quota">
            <span className="app-nav-panel-quota-label">Usage</span>
            <span className="mono">
              {activeSub.articles_used_this_period}/{activeSub.articles_quota} this period
            </span>
          </div>
        )}

        <nav className="app-nav-panel-links">
          {NAV_LINKS.map((l) => (
            <Link key={l.to} to={l.to}>{l.label}</Link>
          ))}
        </nav>

        <div className="app-nav-panel-foot">
          <Link to="/app/settings" className="app-nav-panel-email">{user?.email}</Link>
          <button type="button" className="btn btn-sm btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      {open && (
        <div className="app-nav-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      )}
    </header>
  );
}
