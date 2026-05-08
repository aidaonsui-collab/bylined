// Shared shell for SignIn / SignUp / ForgotPassword / AuthCallback.
// Two-column layout on desktop: form on the left, brand panel on the
// right. Single column on mobile.

import { Link } from 'react-router-dom';

const Logo = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4 L8 12 L14 20" />
    <circle cx="14" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="14" cy="20" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export default function AuthLayout({ title, eyebrow, lede, children, footer }) {
  return (
    <div className="auth-shell">
      <div className="auth-form-col">
        <Link to="/" className="auth-brand">
          <span className="brand-mark"><Logo size={14} /></span>
          <span className="brand-wm">bylined</span>
        </Link>

        <div className="auth-form-inner">
          {eyebrow && <div className="eyebrow auth-eyebrow">{eyebrow}</div>}
          <h1 className="auth-h1 serif">{title}</h1>
          {lede && <p className="auth-lede">{lede}</p>}
          {children}
          {footer && <div className="auth-footer">{footer}</div>}
        </div>
      </div>

      <aside className="auth-brand-col" aria-hidden="true">
        <div className="auth-brand-content">
          <p className="auth-quote serif">
            "Every claim has a <em>receipt</em>."
          </p>
          <p className="auth-quote-sub">
            — the wedge.
          </p>
        </div>
      </aside>
    </div>
  );
}
