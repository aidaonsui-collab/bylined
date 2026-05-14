// First-run checklist on /app. Three steps to a first published
// article. Auto-hides once the user has generated an article, or when
// they dismiss it (dismissal persisted per-user in localStorage so it
// doesn't reappear on every visit).

import { useState } from 'react';
import { Link } from 'react-router-dom';

const DISMISS_KEY = 'bylined.onboarding_dismissed';

const Check = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

function StepDot({ done, n }) {
  return (
    <span
      style={{
        flexShrink: 0,
        width: 22,
        height: 22,
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 600,
        border: '1px solid',
        borderColor: done ? 'transparent' : 'var(--border-2)',
        background: done ? 'var(--accent)' : 'var(--surface-2)',
        color: done ? 'var(--accent-on)' : 'var(--fg-muted)',
      }}
    >
      {done ? <Check /> : n}
    </span>
  );
}

export default function OnboardingChecklist({ sites, voices, hasArticles, userId }) {
  const storageKey = `${DISMISS_KEY}.${userId}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });

  // Nothing to onboard once they've shipped an article, or if dismissed.
  if (hasArticles || dismissed) return null;

  const hasSite = (sites?.length ?? 0) > 0;
  const hasVoice = (voices?.length ?? 0) > 0;

  const dismiss = () => {
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  const steps = [
    {
      n: 1,
      done: hasSite,
      title: 'Connect a site',
      body: 'Link WordPress or Webflow so Bylined can publish for you.',
      to: '/app/sites',
      cta: hasSite ? 'Manage sites' : 'Connect a site',
    },
    {
      n: 2,
      done: hasVoice,
      title: 'Extract a brand voice',
      body: 'Optional — point Bylined at your homepage so articles match your tone.',
      to: '/app/voice',
      cta: hasVoice ? 'Manage voices' : 'Extract a voice',
      optional: true,
    },
    {
      n: 3,
      done: false,
      title: 'Generate your first article',
      body: 'Type a keyword in the box below and hit Generate.',
      to: null,
      cta: null,
    },
  ];

  return (
    <div
      className="app-callout"
      style={{
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 0,
        marginTop: 24,
        padding: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div className="eyebrow">Get started</div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={dismiss}
          title="Hide this checklist"
        >
          Dismiss
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {steps.map((s, i) => (
          <div
            key={s.n}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              padding: '14px 16px',
              borderBottom: i < steps.length - 1 ? '1px solid var(--border)' : 'none',
              opacity: s.done ? 0.6 : 1,
            }}
          >
            <StepDot done={s.done} n={s.n} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--fg)', fontSize: 14 }}>
                {s.title}
                {s.optional && (
                  <span style={{ fontWeight: 400, color: 'var(--fg-subtle)', fontSize: 12 }}>
                    {' '}· optional
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 2 }}>
                {s.body}
              </div>
            </div>
            {s.to && s.cta && (
              <Link
                to={s.to}
                className="btn btn-sm"
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              >
                {s.cta}
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
