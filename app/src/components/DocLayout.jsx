// Minimal single-column shell for static-ish pages: Terms, Privacy,
// 404. No auth, no app chrome — just the wordmark, a back link, and a
// readable column.

import { Link } from 'react-router-dom';

const Logo = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4 L8 12 L14 20" />
    <circle cx="14" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="14" cy="20" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export default function DocLayout({ eyebrow, title, children, backTo = '/', backLabel = 'Home' }) {
  return (
    <div className="app-shell">
      <header className="app-nav">
        <div className="app-nav-inner">
          <Link to="/" className="app-brand">
            <span className="brand-mark"><Logo /></span>
            <span className="brand-wm">bylined</span>
          </Link>
          <div className="app-nav-user">
            <Link to={backTo} className="btn btn-sm btn-ghost">{backLabel}</Link>
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="app-container" style={{ maxWidth: 680 }}>
          {eyebrow && (
            <div className="eyebrow" style={{ marginBottom: 14 }}>{eyebrow}</div>
          )}
          <h1 className="app-h1 serif" style={{ fontSize: 44 }}>{title}</h1>
          <div
            style={{
              marginTop: 24,
              fontSize: 14.5,
              lineHeight: 1.7,
              color: 'var(--fg-muted)',
            }}
          >
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
