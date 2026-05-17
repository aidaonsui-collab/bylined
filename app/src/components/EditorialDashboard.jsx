// Editorial-newsroom dashboard for /app.
//
// Ported from the design bundle (bylinedd) — a redesign of the in-app
// dashboard styled as an "editorial operating system" with newsroom
// typography (Instrument Serif + Geist + JetBrains Mono), warm-toned
// blacks, paper-cream text, and a single lime "signal" accent.
//
// All visual surfaces from the design are wired to real Bylined data:
//   - Masthead         → user + activeSub.quota + nav links
//   - TrialBanner      → pilot sub (days/articles remaining)
//   - StatusStrip      → recent-article count, voice host, site, jobs
//   - HealthGauge      → avg(receipts, aeo, voice) over the 30d window
//   - QualityPillars   → per-pillar score + delta vs prior 30d window
//   - TasksList        → derived from drafts / sites / jobs / quota
//   - VisibilityChart  → mockVisibilityHistory (v1 mock; v2 wires real)
//   - Onboarding       → checklist driven by sites/voices/articles
//   - KeywordForm      → wraps the parent's submit handler unchanged
//   - RecentFeed       → wraps the parent's article/job row + actions
//   - Colophon         → static footer
//
// The Tweaks panel from the design bundle is dropped — accent is fixed
// at lime, and "show trial banner / show onboarding" are driven by
// real state rather than user toggles.
//
// Styling uses inline-style objects (matching the source design) so
// the editorial look is self-contained and doesn't leak into the
// marketing/auth pages. Tokens come from .editorial-shell in
// styles.css; this file references them as var(--ink-0), --paper, etc.

import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { mockVisibilityHistory, VISIBILITY_MAX_PER_WEEK } from '../lib/mockVisibility.js';
import { renderArticle } from '../lib/renderArticle.js';
import { regenerateArticle, retryJob } from '../lib/jobs.js';
import PublishControls from './PublishControls.jsx';

const ACCENT = {
  sig: 'oklch(83% 0.21 130)',
  dim: 'oklch(83% 0.21 130 / 0.18)',
};

// ─── Masthead ─────────────────────────────────────────────────────
// Sticky top of the page: volume/issue line, live indicator, nameplate,
// nav, quota bar, sign-out. Replaces AppNav on /app.

const NAV_LINKS = [
  { to: '/app', label: 'Desk', exact: true },
  { to: '/app/sites', label: 'Sites' },
  { to: '/app/voice', label: 'Voices' },
  { to: '/app/usage', label: 'Usage' },
  { to: '/app/billing', label: 'Billing' },
];

export function Masthead({ activeSub, org }) {
  const { user, signOut } = useAuth();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const today = new Date();
  const dateLine = today
    .toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    .toUpperCase();
  // Day-of-year as issue number — same conceit as the source design.
  const issueNo = useMemo(() => {
    const start = new Date(today.getFullYear(), 0, 0);
    const diff = today - start;
    return String(Math.floor(diff / (1000 * 60 * 60 * 24))).padStart(3, '0');
  }, []);

  const used = activeSub?.articles_used_this_period ?? 0;
  const total = activeSub?.articles_quota ?? 0;
  const pct = total > 0 ? used / total : 0;
  const warn = pct >= 0.9;

  const initials = (user?.email ?? '?')
    .split('@')[0]
    .slice(0, 2)
    .toUpperCase();

  const isActive = (link) =>
    link.exact ? pathname === link.to : pathname.startsWith(link.to);

  return (
    <header style={S.mast.wrap}>
      <div style={S.mast.topRow}>
        <div style={S.mast.metaLeft}>
          <span style={S.mast.metaTxt}>VOL. I · NO. {issueNo}</span>
          <span style={{ color: 'var(--paper-faint)' }}>·</span>
          <span style={S.mast.metaTxt}>{dateLine}</span>
        </div>
        <div style={S.mast.metaRight}>
          <span className="ed-masthead-desktop" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span className="ed-live-dot" />
            <span style={S.mast.metaTxt}>PRESSROOM LIVE</span>
          </span>
          {/* Mobile-only burger lives here in the top row so it sits at the
              very top-right of the header instead of below the nameplate. */}
          <button
            type="button"
            className="ed-masthead-burger"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            style={S.mast.burger}
          >
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>
      </div>

      <div style={S.mast.nameplate}>
        <Link to="/app" style={S.mast.brandRow}>
          <span className="ed-serif" style={{ fontSize: 64, lineHeight: 0.9, letterSpacing: '-0.01em', color: 'var(--paper)' }}>
            Bylined
          </span>
          <span
            className="ed-serif"
            style={{
              fontSize: 18,
              fontStyle: 'italic',
              color: 'var(--paper-dim)',
              marginLeft: 14,
              marginBottom: 8,
            }}
          >
            the desk{org ? ` for ${org}` : ''}
          </span>
        </Link>

        <nav className="ed-masthead-nav" style={S.mast.nav}>
          {NAV_LINKS.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              style={{
                ...S.mast.navItem,
                ...(isActive(l) ? S.mast.navItemActive : null),
              }}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>

      <div style={S.mast.bottomRule}>
        <div style={S.mast.quotaBlock}>
          <span className="ed-eyebrow">
            Quota · {activeSub ? monthLabel(activeSub.current_period_end) : '—'}
          </span>
          <div style={S.mast.quotaBar}>
            <div
              style={{
                ...S.mast.quotaFill,
                width: `${Math.min(100, pct * 100)}%`,
                background: warn ? 'var(--ed-warn)' : ACCENT.sig,
              }}
            />
          </div>
          <span className="ed-mono" style={{ fontSize: 11, color: 'var(--paper-dim)' }}>
            <strong style={{ color: 'var(--paper)', fontWeight: 600 }}>{used}</strong>
            <span style={{ color: 'var(--paper-faint)' }}> / </span>
            {total || '—'} articles
          </span>
        </div>

        <div style={S.mast.bottomRight}>
          <Link
            to="/app/settings"
            title={user?.email}
            className="ed-masthead-desktop"
            style={S.mast.avatar}
          >
            {initials}
          </Link>
          <button
            type="button"
            onClick={signOut}
            className="ed-masthead-desktop"
            style={S.mast.signOutBtn}
            title="Sign out"
          >
            Sign out
          </button>
        </div>
      </div>

      {menuOpen && (
        <div style={S.mast.mobilePanel}>
          {NAV_LINKS.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              onClick={() => setMenuOpen(false)}
              style={{
                ...S.mast.mobileLink,
                color: isActive(l) ? 'var(--paper)' : 'var(--paper-mute)',
              }}
            >
              {l.label}
            </Link>
          ))}
          <Link
            to="/app/settings"
            onClick={() => setMenuOpen(false)}
            style={{ ...S.mast.mobileLink, color: 'var(--paper-mute)' }}
          >
            Settings <span className="ed-mono" style={{ fontSize: 10, marginLeft: 8, color: 'var(--paper-faint)' }}>{user?.email}</span>
          </Link>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              signOut();
            }}
            style={{
              ...S.mast.mobileLink,
              background: 'transparent',
              border: 'none',
              textAlign: 'left',
              cursor: 'pointer',
              color: 'var(--ed-warn)',
              borderBottom: 'none',
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}

// ─── Trial banner ────────────────────────────────────────────────
// Shown only while sub.plan === 'pilot' AND remaining/days > 0.

export function TrialBanner({ activeSub }) {
  if (!activeSub || activeSub.plan !== 'pilot') return null;

  const remaining = Math.max(
    0,
    (activeSub.articles_quota ?? 0) - (activeSub.articles_used_this_period ?? 0),
  );
  const endMs = new Date(activeSub.current_period_end).getTime();
  const daysLeft = Math.max(0, Math.ceil((endMs - Date.now()) / (24 * 60 * 60 * 1000)));
  const expired = daysLeft === 0 || remaining === 0;

  return (
    <div style={S.trial.wrap}>
      <div style={S.trial.left}>
        <span style={{ ...S.trial.tag, color: ACCENT.sig, borderColor: ACCENT.sig }}>
          {expired ? 'TRIAL ENDED' : 'PILOT'}
        </span>
        <span className="ed-serif" style={{ fontSize: 22, fontStyle: 'italic', color: 'var(--paper)' }}>
          {expired
            ? "You're past the pilot desk."
            : `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} on the pilot desk.`}
        </span>
        <span style={{ color: 'var(--paper-dim)', fontSize: 14 }}>
          {expired ? (
            <>Upgrade to keep filing.</>
          ) : (
            <>
              <span className="ed-mono">{remaining}</span> articles still on the house.
            </>
          )}
        </span>
      </div>
      <div style={S.trial.right}>
        <Link to="/app/pricing" style={S.trial.btnGhost}>See plans</Link>
        <Link
          to="/app/pricing"
          style={{ ...S.trial.btnSolid, background: ACCENT.sig, color: 'var(--ink-0)' }}
        >
          Upgrade
        </Link>
      </div>
    </div>
  );
}

// ─── Status strip ────────────────────────────────────────────────
// 5 cells set like a newspaper contents bar. All numbers real.

export function StatusStrip({
  recentArticleCount,
  voiceHost,
  siteName,
  nextRunHours,
  jobsQueued,
  quotaUsed,
  quotaTotal,
}) {
  const items = [
    {
      label: 'Publishing',
      value: recentArticleCount > 0 ? String(recentArticleCount) : '—',
      sub: recentArticleCount > 0 ? 'in last 30d' : 'idle',
      live: recentArticleCount > 0,
    },
    {
      label: 'Brand voice',
      value: voiceHost || 'Not set',
      sub: voiceHost ? 'fingerprint locked' : 'extract one',
      live: !!voiceHost,
    },
    {
      label: 'Connected site',
      value: siteName || 'None',
      sub: siteName ? 'live · auto-publish on' : 'connect one',
      live: !!siteName,
    },
    {
      label: 'Next run',
      value: nextRunHours == null ? '—' : nextRunHours === 0 ? 'now' : `in ${nextRunHours}h`,
      sub: jobsQueued > 0 ? `${jobsQueued} queued` : 'idle',
      live: nextRunHours === 0 && jobsQueued > 0,
    },
    {
      label: 'This period',
      value: `${quotaUsed ?? 0}/${quotaTotal || '—'}`,
      sub: 'articles',
      live: false,
    },
  ];

  return (
    <section className="ed-status-strip" style={S.strip.wrap}>
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            ...S.strip.cell,
            borderRight: i === items.length - 1 ? 'none' : '1px solid var(--rule)',
          }}
        >
          <div style={S.strip.top}>
            <span className="ed-eyebrow">{it.label}</span>
            {it.live && <span className="ed-live-dot" />}
          </div>
          <div className="ed-serif" style={S.strip.value}>{it.value}</div>
          <div style={S.strip.sub}>{it.sub}</div>
        </div>
      ))}
    </section>
  );
}

// ─── Health gauge ────────────────────────────────────────────────
// Half-circle dial w/ ticks, needle, big serif number, italic note,
// per-pillar breakdown bars. Three-pillar avg (receipts + aeo + voice);
// velocity excluded because high velocity isn't quality.

export function HealthGauge({ value, breakdown, note }) {
  const size = 260;
  const stroke = 16;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const safeValue = value == null ? 0 : Math.max(0, Math.min(100, value));
  const pct = safeValue / 100;
  const ticks = Array.from({ length: 21 }, (_, i) => i / 20);

  return (
    <section style={S.gauge.wrap}>
      <div style={S.gauge.header}>
        <span className="ed-eyebrow">Publishing Health</span>
        <span className="ed-mono" style={{ fontSize: 10, color: 'var(--paper-faint)', letterSpacing: '0.1em' }}>
          AVG · 3 PILLARS
        </span>
      </div>

      <div style={S.gauge.dial}>
        <svg width={size} height={size / 2 + 30} viewBox={`0 0 ${size} ${size / 2 + 30}`}>
          <defs>
            <linearGradient id="ed-gauge-grad" x1="0" x2="1">
              <stop offset="0" stopColor={ACCENT.sig} stopOpacity="0.3" />
              <stop offset="1" stopColor={ACCENT.sig} stopOpacity="1" />
            </linearGradient>
          </defs>
          {/* base arc */}
          <path
            d={`M ${stroke / 2} ${cy} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${cy}`}
            fill="none"
            stroke="var(--ink-3)"
            strokeWidth={stroke}
          />
          {/* value arc */}
          <path
            d={`M ${stroke / 2} ${cy} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${cy}`}
            fill="none"
            stroke="url(#ed-gauge-grad)"
            strokeWidth={stroke}
            pathLength="1"
            strokeDasharray={`${pct} 1`}
          />
          {/* tick marks */}
          {ticks.map((t, i) => {
            const a = Math.PI - t * Math.PI;
            const inner = r - stroke / 2 - 4;
            const outer = r + stroke / 2 + (i % 5 === 0 ? 8 : 4);
            return (
              <line
                key={i}
                x1={cx + Math.cos(a) * inner}
                y1={cy - Math.sin(a) * inner}
                x2={cx + Math.cos(a) * outer}
                y2={cy - Math.sin(a) * outer}
                stroke={i % 5 === 0 ? 'var(--paper-faint)' : 'var(--ink-3)'}
                strokeWidth="1"
              />
            );
          })}
          {/* needle */}
          <g
            style={{
              transformOrigin: `${cx}px ${cy}px`,
              transform: `rotate(${-180 + pct * 180}deg)`,
              transition: 'transform 1s cubic-bezier(.5,1.6,.4,1)',
            }}
          >
            <line x1={cx} y1={cy} x2={cx + r - 8} y2={cy} stroke="var(--paper)" strokeWidth="2" strokeLinecap="round" />
            <circle cx={cx + r - 8} cy={cy} r="3" fill={ACCENT.sig} />
          </g>
          <circle cx={cx} cy={cy} r="6" fill="var(--ink-1)" stroke="var(--paper-faint)" strokeWidth="1" />

          <text x={stroke / 2} y={cy + 22} fontFamily="var(--ed-mono)" fontSize="9" fill="var(--paper-faint)" textAnchor="middle">0</text>
          <text x={size / 2} y={18} fontFamily="var(--ed-mono)" fontSize="9" fill="var(--paper-faint)" textAnchor="middle">50</text>
          <text x={size - stroke / 2} y={cy + 22} fontFamily="var(--ed-mono)" fontSize="9" fill="var(--paper-faint)" textAnchor="middle">100</text>
        </svg>

        <div style={S.gauge.readoutWrap}>
          <span className="ed-serif" style={S.gauge.bigNumber}>
            {value == null ? '—' : value}
          </span>
          <span className="ed-mono" style={S.gauge.bigUnit}>/100</span>
        </div>
      </div>

      <p style={S.gauge.note}>
        <span className="ed-serif" style={{ fontStyle: 'italic', color: 'var(--paper-dim)', fontSize: 16 }}>
          “{note}”
        </span>
      </p>

      <div style={S.gauge.breakdown}>
        {Object.entries(breakdown ?? {}).map(([k, v]) => (
          <div key={k} style={S.gauge.bdRow}>
            <span
              className="ed-mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.1em',
                color: 'var(--paper-mute)',
                textTransform: 'uppercase',
                width: 64,
              }}
            >
              {k}
            </span>
            <div style={S.gauge.bdBar}>
              <div
                style={{
                  width: v == null ? 0 : `${Math.min(100, v)}%`,
                  height: '100%',
                  background:
                    v == null ? 'var(--ink-3)' : v >= 60 ? ACCENT.sig : v >= 30 ? 'var(--ed-warn)' : 'var(--ed-fail)',
                }}
              />
            </div>
            <span
              className="ed-mono"
              style={{ fontSize: 11, color: 'var(--paper)', width: 28, textAlign: 'right' }}
            >
              {v == null ? '—' : v}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Quality pillars ─────────────────────────────────────────────
// Vertical bars with horizontal hatching + dashed target line and a
// delta-vs-prior-window readout. Velocity excludes a target line
// because it's a rate-of-spend, not a quality bar.

export function QualityPillars({ pillars }) {
  return (
    <section style={S.pillars.wrap}>
      <div style={S.pillars.header}>
        <span className="ed-eyebrow">Quality Pillars</span>
        <span
          className="ed-mono"
          style={{ fontSize: 10, color: 'var(--paper-faint)', letterSpacing: '0.1em' }}
        >
          LAST 30D
        </span>
      </div>

      <div className="ed-pillars-grid" style={S.pillars.grid}>
        {pillars.map((p) => {
          const isVelocity = p.id === 'velocity';
          const value = p.value;
          const targetReached = value != null && p.target != null && value >= p.target;
          return (
            <div key={p.id} style={S.pillars.col}>
              <div style={S.pillars.colHead}>
                <span className="ed-eyebrow" style={{ fontSize: 9.5 }}>{p.name}</span>
                <span
                  className="ed-mono"
                  style={{
                    fontSize: 9,
                    letterSpacing: '0.12em',
                    color: p.type === 'Real' ? ACCENT.sig : 'var(--paper-mute)',
                  }}
                >
                  {p.type === 'Real' ? 'REAL' : 'HEUR.'}
                </span>
              </div>

              <div style={S.pillars.barTrack}>
                {!isVelocity && p.target != null && (
                  <div style={{ ...S.pillars.target, bottom: `${p.target}%` }}>
                    <span style={S.pillars.targetTick} />
                    <span style={S.pillars.targetLabel}>{p.target}</span>
                  </div>
                )}
                <div
                  style={{
                    ...S.pillars.bar,
                    height: value == null ? '0%' : `${Math.min(100, value)}%`,
                    background: isVelocity
                      ? 'var(--paper-faint)'
                      : targetReached
                      ? ACCENT.sig
                      : value != null && p.target != null && value >= p.target * 0.5
                      ? 'var(--ed-warn)'
                      : 'var(--ed-fail)',
                  }}
                >
                  <div style={S.pillars.hatch} />
                </div>
              </div>

              <div style={S.pillars.colFoot}>
                <span className="ed-serif" style={S.pillars.bigVal}>
                  {value == null ? '—' : value}
                </span>
                <span
                  className="ed-mono"
                  style={{ fontSize: 10, color: 'var(--paper-mute)' }}
                >
                  {isVelocity ? 'of 100' : '/100'}
                </span>
                {p.delta != null && (
                  <span
                    className="ed-mono"
                    style={{
                      fontSize: 10,
                      color: p.delta >= 0 ? ACCENT.sig : 'var(--ed-fail)',
                      letterSpacing: '0.04em',
                      marginTop: 2,
                    }}
                  >
                    {p.delta >= 0 ? '↑' : '↓'} {Math.abs(p.delta)} vs prev
                  </span>
                )}
                <span style={S.pillars.blurb}>{p.blurb}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Tasks list ──────────────────────────────────────────────────
// "The Desk · This Week" — open items use §NN-style numbered bullets
// in warn/signal; closed items are struck through.

export function TasksList({ tasks }) {
  const open = tasks.filter((t) => t.count > 0);
  const closed = tasks.filter((t) => t.count === 0);

  return (
    <section style={S.tasks.wrap}>
      <div style={S.tasks.header}>
        <span className="ed-eyebrow">The Desk · This Week</span>
        <span className="ed-mono" style={{ fontSize: 11, color: 'var(--paper-dim)' }}>
          <strong style={{ color: 'var(--paper)' }}>{open.length}</strong>
          <span style={{ color: 'var(--paper-faint)' }}> / </span>
          {tasks.length} <span style={{ color: 'var(--paper-faint)' }}>open</span>
        </span>
      </div>

      <ul style={S.tasks.list}>
        {open.map((t, i) => (
          <TaskRow key={t.id} t={t} idx={i + 1} done={false} />
        ))}
        {closed.map((t, i) => (
          <TaskRow key={t.id} t={t} idx={open.length + i + 1} done />
        ))}
      </ul>
    </section>
  );
}

function TaskRow({ t, idx, done }) {
  const inner = (
    <>
      <span
        style={{
          ...S.tasks.bullet,
          color: done
            ? 'var(--paper-faint)'
            : t.kind === 'warn'
            ? 'var(--ed-warn)'
            : ACCENT.sig,
        }}
      >
        {done ? '—' : `§${String(idx).padStart(2, '0')}`}
      </span>
      <div style={S.tasks.body}>
        <div
          style={{
            ...S.tasks.label,
            textDecoration: done ? 'line-through' : 'none',
            textDecorationColor: 'var(--paper-faint)',
            color: done ? 'var(--paper-mute)' : 'var(--paper)',
          }}
        >
          {t.label}
        </div>
        <div style={S.tasks.path}>{done ? 'clear' : `→ ${t.href}`}</div>
      </div>
      {done ? (
        <span
          className="ed-mono"
          style={{ ...S.tasks.count, color: 'var(--paper-faint)', fontSize: 16 }}
        >
          0
        </span>
      ) : (
        <span
          className="ed-serif"
          style={{
            ...S.tasks.count,
            color: t.kind === 'warn' ? 'var(--ed-warn)' : ACCENT.sig,
          }}
        >
          {t.count}
        </span>
      )}
    </>
  );

  const liStyle = {
    ...S.tasks.row,
    opacity: done ? 0.5 : 1,
  };

  if (!t.href || t.href.startsWith('#')) {
    return (
      <li style={liStyle}>
        <a href={t.href || '#'} style={S.tasks.link}>{inner}</a>
      </li>
    );
  }
  return (
    <li style={liStyle}>
      <Link to={t.href} style={S.tasks.link}>{inner}</Link>
    </li>
  );
}

// ─── Visibility chart ────────────────────────────────────────────
// Area + line over a paper-grid background, with a PROJECTED·MOCK
// zone after the last real week and a side panel showing this week's
// breakdown + per-engine 5-tick bars. v1 sources from
// mockVisibilityHistory; v2 will swap in visibility_snapshots rows.

export function VisibilityChartEditorial({ userId, signupDate, voiceHost }) {
  const history = useMemo(
    () => mockVisibilityHistory(userId, signupDate),
    [userId, signupDate],
  );

  if (history.length === 0) return null;

  const W = 800;
  const H = 220;
  const padL = 40, padR = 40, padT = 30, padB = 30;
  const maxY = 5;
  const lastWeek = history.length;
  const displayWeeks = Math.max(lastWeek, 8);

  const xFor = (w) => padL + ((w - 1) / Math.max(displayWeeks - 1, 1)) * (W - padL - padR);
  const yFor = (v) => H - padB - (v / maxY) * (H - padT - padB);

  const totals = history.map((h, i) => ({
    w: i + 1,
    total: h.total,
    perplexity: h.perplexity,
    chatgpt: h.chatgpt,
    claude: h.claude,
  }));
  const linePath = totals
    .map((t, i) => `${i === 0 ? 'M' : 'L'} ${xFor(t.w)} ${yFor(t.total)}`)
    .join(' ');
  const areaPath = `${linePath} L ${xFor(totals[totals.length - 1].w)} ${H - padB} L ${xFor(totals[0].w)} ${H - padB} Z`;

  const current = totals[totals.length - 1];
  const prev = totals[totals.length - 2] || { total: 0 };
  const delta = current.total - prev.total;

  const hostDisplay = voiceHost || 'your domain';

  return (
    <section style={S.vis.wrap}>
      <div style={S.vis.headerRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="ed-eyebrow">AI Visibility · Weekly</span>
          <span style={S.vis.preview}>PREVIEW</span>
        </div>
        <div
          className="ed-serif"
          style={{
            fontSize: 32,
            fontStyle: 'italic',
            color: 'var(--paper)',
            marginTop: 8,
            lineHeight: 1.1,
            maxWidth: 620,
          }}
        >
          How often Perplexity, ChatGPT and Claude cite{' '}
          <span style={{ color: ACCENT.sig }}>{hostDisplay}</span> when asked your buyers' questions.
        </div>
        <div className="ed-mono" style={{ fontSize: 11, color: 'var(--paper-faint)', marginTop: 8 }}>
          Real pipeline ships next session. Until then: client-side mock seeded off your user id.
        </div>
      </div>

      <div className="ed-vis-chart-row" style={S.vis.chartRow}>
        <div style={S.vis.chartBox}>
          <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
            <defs>
              <linearGradient id="ed-vis-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={ACCENT.sig} stopOpacity="0.35" />
                <stop offset="100%" stopColor={ACCENT.sig} stopOpacity="0" />
              </linearGradient>
              <pattern id="ed-vis-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--rule)" strokeWidth="0.5" strokeDasharray="2 2" />
              </pattern>
            </defs>

            <rect x={padL} y={padT} width={W - padL - padR} height={H - padT - padB} fill="url(#ed-vis-grid)" />

            {[0, 1, 2, 3, 4, 5].map((y) => (
              <g key={y}>
                <text x={padL - 8} y={yFor(y) + 3} fontFamily="var(--ed-mono)" fontSize="10" fill="var(--paper-faint)" textAnchor="end">{y}</text>
                <line x1={padL} y1={yFor(y)} x2={W - padR} y2={yFor(y)} stroke="var(--rule)" strokeDasharray="1 4" />
              </g>
            ))}

            {Array.from({ length: displayWeeks }, (_, i) => i + 1).map((w) => (
              <text
                key={w}
                x={xFor(w)}
                y={H - padB + 16}
                fontFamily="var(--ed-mono)"
                fontSize="10"
                fill={w <= lastWeek ? 'var(--paper-mute)' : 'var(--paper-ghost)'}
                textAnchor="middle"
              >
                W{w}
              </text>
            ))}

            {/* projection zone (the gray block after the last real week) */}
            {lastWeek < displayWeeks && (
              <>
                <rect
                  x={xFor(lastWeek)}
                  y={padT}
                  width={W - padR - xFor(lastWeek)}
                  height={H - padT - padB}
                  fill="var(--ink-2)"
                  opacity="0.4"
                />
                <text
                  x={xFor(lastWeek) + 8}
                  y={padT + 14}
                  fontFamily="var(--ed-mono)"
                  fontSize="9"
                  fill="var(--paper-faint)"
                  letterSpacing="0.1em"
                >
                  PROJECTED · MOCK
                </text>
              </>
            )}

            <path d={areaPath} fill="url(#ed-vis-fill)" />
            <path d={linePath} fill="none" stroke={ACCENT.sig} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

            {totals.map((t) => (
              <g key={t.w}>
                <circle cx={xFor(t.w)} cy={yFor(t.total)} r="4" fill="var(--ink-0)" stroke={ACCENT.sig} strokeWidth="2" />
                <text x={xFor(t.w)} y={yFor(t.total) - 12} fontFamily="var(--ed-mono)" fontSize="10" fill="var(--paper)" textAnchor="middle">{t.total}</text>
              </g>
            ))}
          </svg>
        </div>

        <aside style={S.vis.side}>
          <div className="ed-eyebrow">Week {current.w}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
            <span className="ed-serif" style={{ fontSize: 64, lineHeight: 0.9, letterSpacing: '-0.02em', color: 'var(--paper)' }}>
              {current.total}
            </span>
            <span className="ed-mono" style={{ fontSize: 11, color: 'var(--paper-mute)' }}>
              of {VISIBILITY_MAX_PER_WEEK} possible
            </span>
          </div>
          {totals.length > 1 && (
            <div
              className="ed-mono"
              style={{
                fontSize: 11,
                color: delta >= 0 ? ACCENT.sig : 'var(--ed-fail)',
                marginTop: 4,
              }}
            >
              {delta >= 0 ? '↑' : '↓'} {Math.abs(delta)} vs week {current.w - 1}
            </div>
          )}

          <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--rule)' }}>
            <div className="ed-eyebrow" style={{ marginBottom: 10 }}>Engines</div>
            {[
              { name: 'Perplexity', val: current.perplexity, of: 5 },
              { name: 'ChatGPT', val: current.chatgpt, of: 5 },
              { name: 'Claude', val: current.claude, of: 5 },
            ].map((e) => (
              <div key={e.name} style={S.vis.engineRow}>
                <span style={{ fontSize: 13, color: 'var(--paper)' }}>{e.name}</span>
                <div style={S.vis.engineBars}>
                  {Array.from({ length: e.of }, (_, i) => (
                    <span
                      key={i}
                      style={{
                        ...S.vis.tick,
                        background: i < e.val ? ACCENT.sig : 'var(--ink-3)',
                      }}
                    />
                  ))}
                </div>
                <span className="ed-mono" style={{ fontSize: 11, color: 'var(--paper-dim)', width: 28, textAlign: 'right' }}>
                  {e.val}/{e.of}
                </span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

// ─── Onboarding checklist ────────────────────────────────────────
// Renders only when not every step is done. Per-user dismissal
// preserved in localStorage so dashboard isn't permanently noisy.

const ONBOARD_DISMISS_KEY = 'bylined.editorial_onboarding_dismissed';

export function Onboarding({ sites, voices, hasArticles, userId }) {
  const storageKey = userId ? `${ONBOARD_DISMISS_KEY}.${userId}` : null;
  const [dismissed, setDismissed] = useState(() => {
    if (!storageKey) return false;
    try {
      return localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });

  const hasSite = (sites?.length ?? 0) > 0;
  const hasVoice = (voices?.length ?? 0) > 0;
  const items = [
    { id: 'site', label: 'Connect a site', done: hasSite, href: '/app/sites' },
    { id: 'voice', label: 'Capture brand voice', done: hasVoice, href: '/app/voice' },
    { id: 'first', label: 'Ship your first article', done: hasArticles, href: null },
    { id: 'auto', label: 'Turn on auto-publish', done: hasSite && hasArticles, href: '/app/sites' },
  ];
  const done = items.filter((i) => i.done).length;
  const allDone = done === items.length;
  if (allDone || dismissed) return null;

  const dismiss = () => {
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, '1');
      } catch {
        /* ignore */
      }
    }
    setDismissed(true);
  };

  return (
    <section className="ed-onb-wrap" style={S.onb.wrap}>
      <div style={S.onb.left}>
        <span className="ed-eyebrow">Getting onto the front page</span>
        <h2 className="ed-serif" style={S.onb.title}>
          You're {done} of {items.length} the way to publishing live.
        </h2>
        <button type="button" onClick={dismiss} style={S.onb.dismiss}>
          Dismiss
        </button>
      </div>
      <ol style={S.onb.list}>
        {items.map((it, i) => (
          <li
            key={it.id}
            style={{ ...S.onb.item, opacity: it.done ? 0.5 : 1 }}
          >
            <span
              style={{
                ...S.onb.dot,
                background: it.done ? ACCENT.sig : 'transparent',
                borderColor: it.done ? ACCENT.sig : 'var(--paper-faint)',
              }}
            >
              {it.done && <span style={{ color: 'var(--ink-0)', fontSize: 11, fontWeight: 700 }}>✓</span>}
            </span>
            <span
              style={{
                ...S.onb.itemLabel,
                textDecoration: it.done ? 'line-through' : 'none',
                color: it.done ? 'var(--paper-mute)' : 'var(--paper)',
              }}
            >
              <span className="ed-mono" style={{ color: 'var(--paper-faint)', marginRight: 8, fontSize: 11 }}>
                0{i + 1}
              </span>
              {it.label}
            </span>
            {!it.done && it.href && (
              <Link to={it.href} style={{ ...S.onb.cta, color: ACCENT.sig }}>
                Start →
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ─── Keyword form / assignment desk ──────────────────────────────
// Wraps the parent's submit handler. State (text, voice, site, live)
// is owned by the parent so it survives the form being unmounted/
// re-mounted during data refetches.

export function KeywordForm({
  keyword,
  setKeyword,
  voiceId,
  setVoiceId,
  autoPublishSiteId,
  setAutoPublishSiteId,
  autoPublishLive,
  setAutoPublishLive,
  voices,
  sites,
  submitting,
  canSubmit,
  remaining,
  keywordCount,
  overCap,
  overQuota,
  maxBulk,
  onSubmit,
}) {
  const lines = keyword.split('\n').map((s) => s.trim()).filter(Boolean);
  const count = Math.min(lines.length, maxBulk);

  return (
    <section style={S.kw.wrap}>
      <div style={S.kw.header}>
        <div>
          <span className="ed-eyebrow">Assignment Desk</span>
          <h2 className="ed-serif" style={S.kw.title}>
            Hand the writers their assignments.
          </h2>
        </div>
        <span style={S.kw.tag}>BATCH</span>
      </div>

      <form onSubmit={onSubmit} className="ed-kw-body" style={S.kw.body}>
        <div style={S.kw.editorWrap}>
          <div style={S.kw.gutter}>
            {lines.length === 0 ? (
              <div style={S.kw.gutterNum}>1</div>
            ) : (
              lines.map((_, i) => (
                <div
                  key={i}
                  style={{
                    ...S.kw.gutterNum,
                    color: i >= maxBulk ? 'var(--ed-fail)' : 'var(--paper-faint)',
                  }}
                >
                  {i + 1}
                </div>
              ))
            )}
          </div>
          <textarea
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={
              'embedded payments compliance checklist\n' +
              'subscription churn benchmarks 2026\n' +
              'how to detect refund fraud at scale'
            }
            style={S.kw.textarea}
            spellCheck="false"
            disabled={submitting || remaining === 0}
          />
        </div>

        <aside style={S.kw.controls}>
          <div>
            <span className="ed-eyebrow" style={{ marginBottom: 8, display: 'block' }}>
              Brand voice
            </span>
            <select
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              disabled={submitting || voices.length === 0}
              style={S.kw.select}
            >
              <option value="">No voice (generic style)</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {safeHostname(v.source_url)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className="ed-eyebrow" style={{ marginBottom: 8, display: 'block' }}>
              Auto-publish target
            </span>
            <select
              value={autoPublishSiteId}
              onChange={(e) => setAutoPublishSiteId(e.target.value)}
              disabled={submitting || sites.length === 0}
              style={S.kw.select}
            >
              <option value="">None — keep as draft</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.cms_type})
                </option>
              ))}
            </select>
          </div>
          {autoPublishSiteId && (
            <label style={S.kw.checkRow}>
              <input
                type="checkbox"
                checked={autoPublishLive}
                onChange={(e) => setAutoPublishLive(e.target.checked)}
                style={{ accentColor: ACCENT.sig }}
                disabled={submitting}
              />
              <span style={{ fontSize: 13 }}>Publish live (uncheck for draft)</span>
            </label>
          )}

          <div style={S.kw.footer}>
            <div
              className="ed-mono"
              style={{
                fontSize: 11,
                color:
                  overCap || overQuota ? 'var(--ed-fail)' : 'var(--paper-mute)',
              }}
            >
              {overCap
                ? `${lines.length}/${maxBulk} · ${lines.length - maxBulk} will be cut`
                : overQuota
                ? `${keywordCount} requested · only ${remaining} left in quota`
                : `${count}/${maxBulk} keywords`}
            </div>
            <button
              type="submit"
              disabled={!canSubmit}
              style={{
                ...S.kw.go,
                background: canSubmit ? ACCENT.sig : 'var(--ink-3)',
                color: canSubmit ? 'var(--ink-0)' : 'var(--paper-faint)',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
            >
              {submitting
                ? 'Sending…'
                : remaining === 0
                ? 'Quota used'
                : keywordCount > 1
                ? `Send ${keywordCount} to press →`
                : 'Send to press →'}
            </button>
          </div>
        </aside>
      </form>
    </section>
  );
}

// ─── Recent feed ─────────────────────────────────────────────────
// Chronological wire of articles + jobs. Article rows expand to a
// preview/raw toggle with the same Publish / Regenerate / Open
// detail controls as before — just re-skinned.

export function RecentFeed({ rows, sites, userId, onChanged, toast, onLoadMore, canLoadMore }) {
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = useState('All');

  const filtered = rows.filter((r) => {
    if (filter === 'All') return true;
    if (filter === 'Articles') return r.kind === 'article';
    if (filter === 'Jobs') return r.kind === 'job';
    return true;
  });

  return (
    <section style={S.feed.wrap}>
      <div style={S.feed.header}>
        <span className="ed-eyebrow">The Wire · Recent</span>
        <div style={S.feed.tabs}>
          {['All', 'Articles', 'Jobs'].map((t, i) => (
            <button
              key={t}
              type="button"
              onClick={() => setFilter(t)}
              style={{
                ...S.feed.tab,
                ...(filter === t ? S.feed.tabActive : null),
                borderRight: i < 2 ? '1px solid var(--rule)' : 'none',
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: '40px 4px', color: 'var(--paper-mute)', fontSize: 14, borderTop: '1px solid var(--rule-strong)' }}>
          {filter === 'All'
            ? 'No articles yet. Hand the writers an assignment above to get started.'
            : `No ${filter.toLowerCase()} yet.`}
        </div>
      ) : (
        <ol style={S.feed.list}>
          {filtered.map((r, idx) => (
            <FeedRow
              key={r.kind === 'article' ? `a-${r.article.id}` : `j-${r.job.id}`}
              row={r}
              idx={idx}
              isOpen={r.kind === 'article' && expandedId === r.article.id}
              onToggle={() =>
                r.kind === 'article'
                  ? setExpandedId(expandedId === r.article.id ? null : r.article.id)
                  : undefined
              }
              sites={sites}
              userId={userId}
              onChanged={onChanged}
              toast={toast}
            />
          ))}
        </ol>
      )}

      {canLoadMore && (
        <div style={S.feed.loadMore}>
          <button type="button" onClick={onLoadMore} style={S.feed.loadBtn}>
            Load 20 more →
          </button>
        </div>
      )}
    </section>
  );
}

function FeedRow({ row, idx, isOpen, onToggle, sites, userId, onChanged, toast }) {
  const isArticle = row.kind === 'article';
  const status = isArticle
    ? row.article.status === 'published'
      ? 'published'
      : 'draft'
    : row.job.status;

  const statusColor = (s) =>
    ({
      draft: 'var(--ed-warn)',
      published: ACCENT.sig,
      queued: 'var(--paper-mute)',
      running: ACCENT.sig,
      failed: 'var(--ed-fail)',
      completed: ACCENT.sig,
    }[s] || 'var(--paper-mute)');

  const statusLabel = (s) =>
    ({
      draft: 'DRAFT',
      published: 'PUBLISHED',
      queued: 'QUEUED',
      running: 'ON PRESS',
      failed: 'KILLED',
      completed: 'DONE',
    }[s] || s.toUpperCase());

  const title = isArticle ? row.article.title || row.article.keyword : row.job.keyword;
  const ts = isArticle ? relTime(row.article.generated_at) : relTime(row.job.created_at);

  return (
    <li
      style={{
        ...S.feed.row,
        background: isOpen ? 'var(--ink-1)' : 'transparent',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="ed-feed-row-head"
        style={S.feed.rowHead}
      >
        <span className="ed-mono" style={S.feed.tsCol}>
          <span style={{ color: 'var(--paper-faint)', marginRight: 8 }}>#{String(idx + 1).padStart(2, '0')}</span>
          {ts}
        </span>
        <span
          className="ed-mono"
          style={{
            ...S.feed.statusChip,
            color: statusColor(status),
            borderColor: statusColor(status),
          }}
        >
          {statusLabel(status)}
        </span>
        <span className="ed-serif" style={S.feed.title}>{title}</span>
        {isArticle && (
          <span className="ed-feed-scores" style={S.feed.scores}>
            <ScoreChip letter="R" value={Math.round((row.article.pass_rate ?? 0) * 100)} threshold={95} />
            <ScoreChip letter="A" value={row.article.aeo_score ?? 0} threshold={60} />
            <ScoreChip
              letter="V"
              value={row.article.voice_match_score ?? 0}
              threshold={60}
              failBelow={60}
            />
          </span>
        )}
        <span
          className="ed-feed-chev"
          style={{
            ...S.feed.chev,
            transform: isArticle && isOpen ? 'rotate(90deg)' : 'none',
            visibility: isArticle ? 'visible' : 'hidden',
          }}
        >
          ›
        </span>
      </button>

      {!isArticle && row.job.status === 'failed' && row.job.error && (
        <div
          className="ed-mono"
          style={{
            margin: '0 4px 14px',
            padding: '10px 12px',
            fontSize: 11.5,
            color: 'var(--paper-dim)',
            background: 'var(--ink-2)',
            border: '1px solid var(--rule)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {row.job.error}
        </div>
      )}

      {!isArticle && row.job.status === 'failed' && (
        <div style={{ padding: '0 4px 14px' }}>
          <button
            type="button"
            style={S.feed.minorBtn}
            onClick={async () => {
              const result = await retryJob(row.job.id);
              if (!result.ok) {
                toast(result.error || 'Retry failed.', { tone: 'danger' });
                return;
              }
              toast('Re-queued — no quota charge for retries.', { tone: 'success' });
              onChanged?.();
            }}
          >
            Retry
          </button>
        </div>
      )}

      {isOpen && isArticle && (
        <ArticleBody
          article={row.article}
          sites={sites}
          userId={userId}
          onChanged={onChanged}
          toast={toast}
        />
      )}
    </li>
  );
}

function ScoreChip({ letter, value, threshold, failBelow }) {
  const color =
    value >= threshold
      ? ACCENT.sig
      : failBelow != null && value < failBelow
      ? 'var(--ed-fail)'
      : 'var(--ed-warn)';
  return (
    <span style={S.feed.scoreChip} title={`${letter}: ${value}`}>
      <span className="ed-mono" style={{ fontSize: 9, color: 'var(--paper-faint)' }}>{letter}</span>
      <span className="ed-mono" style={{ fontSize: 11, color }}>{value}</span>
    </span>
  );
}

function ArticleBody({ article, sites, userId, onChanged, toast }) {
  const [view, setView] = useState('preview');
  const renderedHtml = useMemo(
    () => renderArticle(article.body_markdown, article.receipts),
    [article.body_markdown, article.receipts],
  );

  return (
    <div style={S.feed.body}>
      <div style={S.feed.bodyToolbar}>
        <div style={S.feed.viewToggle}>
          {['preview', 'raw'].map((v, i) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              style={{
                ...S.feed.viewBtn,
                ...(view === v ? S.feed.viewBtnActive : null),
                borderRight: i === 0 ? '1px solid var(--rule)' : 'none',
              }}
            >
              {v}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <Link to={`/app/articles/${article.id}`} style={S.feed.minorBtn}>
          Open detail
        </Link>
        <button
          type="button"
          style={S.feed.minorBtn}
          onClick={() => {
            navigator.clipboard.writeText(article.body_markdown);
            toast('Markdown copied', { tone: 'success' });
          }}
        >
          Copy MD
        </button>
        <button
          type="button"
          style={S.feed.minorBtn}
          onClick={async () => {
            if (
              !confirm(
                'Regenerate? Queues a fresh job (same keyword + voice) and counts as one article against your quota.',
              )
            )
              return;
            const result = await regenerateArticle(article, userId);
            if (!result.ok) {
              toast(result.error, { tone: 'danger' });
              return;
            }
            toast('Regeneration queued.', { tone: 'success' });
            onChanged?.();
          }}
        >
          Regenerate
        </button>
        <div style={S.feed.publishWrap}>
          <PublishControls
            article={article}
            sites={sites}
            onPublished={onChanged}
            toast={toast}
          />
        </div>
      </div>

      {view === 'preview' ? (
        <article style={S.feed.preview}>
          {article.meta_description && (
            <p style={S.feed.previewLede}>{article.meta_description}</p>
          )}
          <div
            className="article-prose"
            style={{
              padding: 0,
              background: 'transparent',
              borderRadius: 0,
              maxHeight: 480,
              overflow: 'auto',
              color: 'var(--paper)',
            }}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
          <div style={S.feed.previewMeta}>
            <span className="ed-mono">5-gate verified</span>
            <span style={{ color: 'var(--paper-faint)' }}>·</span>
            <span className="ed-mono">{Math.round((article.pass_rate ?? 0) * 100)}% receipts</span>
            {article.published_at && (
              <>
                <span style={{ color: 'var(--paper-faint)' }}>·</span>
                <span className="ed-mono">published {relTime(article.published_at)}</span>
              </>
            )}
          </div>
        </article>
      ) : (
        <pre style={S.feed.raw}>{article.body_markdown}</pre>
      )}
    </div>
  );
}

// ─── Colophon ────────────────────────────────────────────────────

export function Colophon({ org }) {
  return (
    <footer style={S.col.wrap}>
      <div style={S.col.row}>
        <span className="ed-serif" style={{ fontSize: 22, fontStyle: 'italic', color: 'var(--paper)' }}>Bylined</span>
        <span className="ed-mono" style={{ fontSize: 10, color: 'var(--paper-faint)' }}>·</span>
        <span className="ed-mono" style={{ fontSize: 10, color: 'var(--paper-mute)', letterSpacing: '0.1em' }}>
          SET IN INSTRUMENT SERIF &amp; GEIST
        </span>
        {org && (
          <>
            <span className="ed-mono" style={{ fontSize: 10, color: 'var(--paper-faint)' }}>·</span>
            <span className="ed-mono" style={{ fontSize: 10, color: 'var(--paper-mute)', letterSpacing: '0.1em' }}>
              PRESSED FOR {org.toUpperCase()}
            </span>
          </>
        )}
      </div>
      <div style={S.col.row}>
        <span className="ed-live-dot" />
        <span className="ed-mono" style={{ fontSize: 10, color: 'var(--paper-mute)', letterSpacing: '0.1em' }}>
          ALL PRESSES NOMINAL
        </span>
      </div>
    </footer>
  );
}

// ─── helpers ─────────────────────────────────────────────────────

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function relTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function monthLabel(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short' });
  } catch {
    return '—';
  }
}

// Computes pillar deltas vs prior 30d window. Caller passes both
// windows of articles; we return the per-pillar avg delta or null
// when the prior window has no signal.
export function computePillars({ recent, prior, quotaUsed, quotaTotal }) {
  const avg = (arr, key, scale = 1) => {
    const nums = arr
      .map((a) => a[key])
      .filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (nums.length === 0) return null;
    return Math.round((nums.reduce((s, v) => s + v, 0) / nums.length) * scale);
  };

  const recReceipts = avg(recent, 'pass_rate', 100);
  const recAeo = avg(recent, 'aeo_score');
  const recVoice = avg(recent, 'voice_match_score');
  const priorReceipts = avg(prior, 'pass_rate', 100);
  const priorAeo = avg(prior, 'aeo_score');
  const priorVoice = avg(prior, 'voice_match_score');

  const deltaOf = (curr, prev) =>
    curr == null || prev == null ? null : curr - prev;

  const velocity = quotaTotal > 0 ? Math.round((quotaUsed / quotaTotal) * 100) : 0;

  return [
    {
      id: 'receipts',
      name: 'Receipts',
      value: recReceipts,
      target: 95,
      type: 'Real',
      delta: deltaOf(recReceipts, priorReceipts),
      blurb: '5-gate verifier pass rate',
    },
    {
      id: 'aeo',
      name: 'AEO',
      value: recAeo,
      target: 60,
      type: 'Heuristic',
      delta: deltaOf(recAeo, priorAeo),
      blurb: 'LLM-citability heuristic',
    },
    {
      id: 'voice',
      name: 'Voice',
      value: recVoice,
      target: 60,
      type: 'Heuristic',
      delta: deltaOf(recVoice, priorVoice),
      blurb: 'Brand-voice fingerprint match',
    },
    {
      id: 'velocity',
      name: 'Velocity',
      value: velocity,
      target: null,
      type: 'Real',
      delta: null,
      blurb: 'Quota burned this period',
    },
  ];
}

// Builds the canonical "tasks" list for the right rail. Mirrors the
// rules from the prior DashboardOverview so behavior is unchanged.
export function computeTasks({ articles, jobs, sites, quotaUsed, quotaTotal }) {
  const draftCount = (articles ?? []).filter((a) => a.status === 'draft').length;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const failedJobs = (jobs ?? []).filter(
    (j) => j.status === 'failed' && new Date(j.created_at).getTime() >= sevenDaysAgo,
  ).length;
  const sitesNoVoice = (sites ?? []).filter((s) => s.is_active && !s.voice_id).length;
  const lowReceipts = (articles ?? []).filter((a) => {
    const t = a.generated_at ? new Date(a.generated_at).getTime() : 0;
    const since30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return t >= since30 && typeof a.pass_rate === 'number' && a.pass_rate < 0.95;
  }).length;
  const quotaPct = quotaTotal > 0 ? quotaUsed / quotaTotal : 0;
  const quotaWarn = quotaPct >= 0.9 && quotaPct < 1 ? 1 : 0;

  return [
    { id: 'drafts', label: 'Drafts awaiting publish', count: draftCount, kind: 'warn', href: '#recent' },
    { id: 'voice', label: 'Sites missing voice fingerprint', count: sitesNoVoice, kind: 'warn', href: '/app/sites' },
    { id: 'below', label: 'Articles below 95% receipts', count: lowReceipts, kind: 'warn', href: '#recent' },
    { id: 'failed', label: 'Failed jobs (last 7d)', count: failedJobs, kind: 'warn', href: '#recent' },
    { id: 'quota', label: 'Quota nearing limit', count: quotaWarn, kind: 'warn', href: '/app/billing' },
  ];
}

// Health note copy keyed off the overall score. Two-tier wording so
// the note hints at the highest-leverage fix.
export function healthNote(health, breakdown) {
  if (health == null) return 'Ship a few articles to get scored.';
  if (health >= 80) return 'Looking healthy. Keep shipping.';
  const weakest = ['receipts', 'aeo', 'voice']
    .filter((k) => breakdown[k] != null)
    .sort((a, b) => (breakdown[a] ?? 100) - (breakdown[b] ?? 100))[0];
  if (health >= 60) {
    if (weakest === 'voice') return 'Solid. Lift Voice and you cross 80.';
    if (weakest === 'aeo') return 'Solid. AEO is the next bar to clear.';
    return 'Solid. Small wins push this into the 80s.';
  }
  if (health >= 40) return 'Receipts and AEO need attention.';
  return 'Below target — check drafts before they publish.';
}

// Pick a "press dial" needle position from the user's email domain
// or first-voice host so the masthead has something specific to lead
// with. Returns null when nothing useful is available.
export function pickOrgName({ user, voices, sites }) {
  if (sites?.[0]?.name) return sites[0].name;
  if (voices?.[0]?.source_url) {
    const h = safeHostname(voices[0].source_url);
    if (h) return h;
  }
  if (user?.user_metadata?.full_name) return user.user_metadata.full_name.split(' ')[0];
  if (user?.email) {
    const domain = user.email.split('@')[1];
    if (domain && !['gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com', 'icloud.com'].includes(domain)) {
      return domain.split('.')[0].replace(/^./, (c) => c.toUpperCase());
    }
    return user.email.split('@')[0];
  }
  return null;
}

// ─── Style objects (all in one place so the JSX stays readable) ──

const S = {
  mast: {
    wrap: {
      paddingTop: 22,
      borderBottom: '1px solid var(--rule)',
      background: 'var(--ink-0)',
      position: 'sticky',
      top: 0,
      zIndex: 30,
    },
    topRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 32px 14px' },
    metaLeft: { display: 'flex', gap: 10, alignItems: 'center' },
    metaRight: { display: 'flex', gap: 8, alignItems: 'center' },
    metaTxt: { fontFamily: 'var(--ed-mono)', fontSize: 10.5, letterSpacing: '0.12em', color: 'var(--paper-mute)' },
    nameplate: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-end',
      padding: '18px 32px',
      borderTop: '1px solid var(--rule-strong)',
      borderBottom: '3px double var(--rule-strong)',
    },
    brandRow: { display: 'flex', alignItems: 'flex-end', cursor: 'pointer' },
    nav: { display: 'flex', gap: 28, paddingBottom: 8 },
    navItem: {
      fontFamily: 'var(--ed-mono)',
      fontSize: 11,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: 'var(--paper-mute)',
      cursor: 'pointer',
      paddingBottom: 4,
      borderBottom: '1px solid transparent',
    },
    navItemActive: { color: 'var(--paper)', borderBottom: '1px solid var(--paper)' },
    bottomRule: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 32px', flexWrap: 'wrap', gap: 12 },
    quotaBlock: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
    quotaBar: { width: 220, height: 6, background: 'var(--ink-2)', border: '1px solid var(--rule)', position: 'relative', overflow: 'hidden' },
    quotaFill: { height: '100%', transition: 'width .3s ease' },
    bottomRight: { display: 'flex', alignItems: 'center', gap: 14 },
    avatar: {
      width: 30, height: 30, borderRadius: '50%',
      background: 'var(--ink-2)', border: '1px solid var(--rule-strong)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--ed-mono)', fontSize: 10, color: 'var(--paper-dim)',
      letterSpacing: '0.05em', cursor: 'pointer',
    },
    signOutBtn: {
      background: 'transparent', border: '1px solid var(--rule-strong)',
      color: 'var(--paper-dim)', padding: '5px 12px',
      fontFamily: 'var(--ed-mono)', fontSize: 10, letterSpacing: '0.12em',
      textTransform: 'uppercase', borderRadius: 3, cursor: 'pointer',
    },
    burger: {
      // display toggled by CSS — hidden on desktop, shown <960px.
      background: 'var(--ink-2)', border: '1px solid var(--rule)',
      color: 'var(--paper)', padding: '4px 12px',
      borderRadius: 4, cursor: 'pointer',
      fontSize: 16, lineHeight: 1,
    },
    mobilePanel: {
      display: 'flex', flexDirection: 'column',
      padding: '14px 32px 18px',
      background: 'var(--ink-1)',
      borderTop: '1px solid var(--rule)',
    },
    mobileLink: {
      padding: '12px 0',
      borderBottom: '1px solid var(--rule)',
      fontFamily: 'var(--ed-mono)', fontSize: 12,
      letterSpacing: '0.12em', textTransform: 'uppercase',
    },
  },

  trial: {
    wrap: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      margin: '20px 32px 0',
      padding: '14px 18px',
      background: 'linear-gradient(90deg, var(--ink-1) 0%, var(--ink-2) 100%)',
      border: '1px solid var(--rule)',
      borderLeft: '2px solid var(--rule-strong)',
      flexWrap: 'wrap', gap: 16,
    },
    left: { display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' },
    tag: {
      fontFamily: 'var(--ed-mono)', fontSize: 10,
      letterSpacing: '0.16em', padding: '3px 8px',
      border: '1px solid', borderRadius: 2,
    },
    right: { display: 'flex', gap: 8 },
    btnGhost: {
      background: 'transparent', color: 'var(--paper-dim)',
      border: '1px solid var(--rule-strong)',
      padding: '8px 14px',
      fontFamily: 'var(--ed-mono)', fontSize: 11,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      borderRadius: 3, cursor: 'pointer',
    },
    btnSolid: {
      border: 'none', padding: '8px 14px',
      fontFamily: 'var(--ed-mono)', fontSize: 11,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      borderRadius: 3, fontWeight: 600, cursor: 'pointer',
    },
  },

  strip: {
    wrap: {
      display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
      borderBottom: '1px solid var(--rule)',
      borderTop: '1px solid var(--rule)',
      marginTop: 20,
    },
    cell: { padding: '18px 24px', minHeight: 96, minWidth: 0 },
    top: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
    value: { fontSize: 28, lineHeight: 1.05, letterSpacing: '-0.01em', color: 'var(--paper)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    sub: { fontFamily: 'var(--ed-mono)', fontSize: 10.5, color: 'var(--paper-mute)', marginTop: 4, letterSpacing: '0.04em' },
  },

  gauge: {
    wrap: { padding: 24, borderRight: '1px solid var(--rule)', display: 'flex', flexDirection: 'column' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    dial: { position: 'relative', display: 'flex', justifyContent: 'center', marginTop: 14, marginBottom: 6 },
    readoutWrap: {
      position: 'absolute', bottom: 24, left: 0, right: 0,
      textAlign: 'center', display: 'flex',
      flexDirection: 'column', alignItems: 'center',
    },
    bigNumber: { fontSize: 56, lineHeight: 1, letterSpacing: '-0.02em', color: 'var(--paper)' },
    bigUnit: { fontSize: 11, color: 'var(--paper-mute)', letterSpacing: '0.1em', marginTop: 2 },
    note: { margin: '8px 0 18px', textAlign: 'center', lineHeight: 1.4 },
    breakdown: { display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 14, borderTop: '1px dashed var(--rule)' },
    bdRow: { display: 'flex', alignItems: 'center', gap: 10 },
    bdBar: { flex: 1, height: 4, background: 'var(--ink-2)', border: '1px solid var(--rule)', overflow: 'hidden' },
  },

  pillars: {
    wrap: { padding: 24, borderRight: '1px solid var(--rule)', display: 'flex', flexDirection: 'column' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, flex: 1 },
    col: { display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 4px 8px 10px', borderLeft: '1px solid var(--rule)' },
    colHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    barTrack: {
      position: 'relative', height: 180,
      background: 'var(--ink-2)', border: '1px solid var(--rule)',
      display: 'flex', flexDirection: 'column-reverse', overflow: 'hidden',
    },
    bar: { width: '100%', position: 'relative', transition: 'height 1.2s cubic-bezier(.4,1.6,.4,1)' },
    hatch: {
      position: 'absolute', inset: 0,
      backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 6px)',
      mixBlendMode: 'multiply',
    },
    target: {
      position: 'absolute', left: -6, right: -6,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      pointerEvents: 'none', zIndex: 2,
    },
    targetTick: { flex: 1, height: 0, borderTop: '1px dashed var(--paper-faint)' },
    targetLabel: {
      fontFamily: 'var(--ed-mono)', fontSize: 9,
      color: 'var(--paper-faint)', letterSpacing: '0.06em',
      position: 'absolute', right: -2, top: -16,
      background: 'var(--ink-1)', padding: '1px 3px',
    },
    colFoot: { display: 'flex', flexDirection: 'column', gap: 2 },
    bigVal: { fontSize: 34, lineHeight: 1, letterSpacing: '-0.01em', color: 'var(--paper)' },
    blurb: { fontSize: 10.5, color: 'var(--paper-faint)', marginTop: 6, lineHeight: 1.35 },
  },

  tasks: {
    wrap: { padding: 24, display: 'flex', flexDirection: 'column', height: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
    list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', flex: 1 },
    row: { borderTop: '1px solid var(--rule)' },
    link: {
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '12px 0', color: 'inherit',
    },
    bullet: {
      fontFamily: 'var(--ed-mono)', fontSize: 10,
      letterSpacing: '0.08em', width: 28,
    },
    body: { flex: 1, minWidth: 0 },
    label: { fontSize: 14, lineHeight: 1.3 },
    path: {
      fontFamily: 'var(--ed-mono)', fontSize: 10,
      color: 'var(--paper-faint)', marginTop: 2, letterSpacing: '0.04em',
    },
    count: { fontSize: 26, lineHeight: 1, letterSpacing: '-0.02em' },
  },

  vis: {
    wrap: { padding: '32px', borderTop: '1px solid var(--rule)' },
    headerRow: { marginBottom: 24 },
    preview: {
      fontFamily: 'var(--ed-mono)', fontSize: 9.5,
      letterSpacing: '0.18em', padding: '3px 8px',
      color: 'var(--ed-warn)', border: '1px solid var(--ed-warn)',
      borderRadius: 2,
    },
    chartRow: { display: 'grid', gridTemplateColumns: '1fr 260px', gap: 32, alignItems: 'stretch' },
    chartBox: { background: 'var(--ink-1)', border: '1px solid var(--rule)', padding: 12 },
    side: { padding: 20, background: 'var(--ink-1)', border: '1px solid var(--rule)' },
    engineRow: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 0', borderBottom: '1px dashed var(--rule)', gap: 12,
    },
    engineBars: { display: 'flex', gap: 3, flex: 1, justifyContent: 'center' },
    tick: { width: 10, height: 14, display: 'inline-block', border: '1px solid var(--rule)' },
  },

  onb: {
    wrap: {
      display: 'grid', gridTemplateColumns: '320px 1fr',
      gap: 32, padding: '40px 32px',
      borderTop: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)',
      background: 'var(--ink-1)',
    },
    left: { display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' },
    title: {
      margin: 0, fontSize: 30, lineHeight: 1.05,
      letterSpacing: '-0.01em', color: 'var(--paper)', fontStyle: 'italic',
    },
    dismiss: {
      marginTop: 4, background: 'transparent', border: 'none',
      color: 'var(--paper-faint)', fontFamily: 'var(--ed-mono)',
      fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
      padding: 0, cursor: 'pointer',
    },
    list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column' },
    item: {
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '14px 0', borderTop: '1px solid var(--rule)',
    },
    dot: {
      width: 18, height: 18, borderRadius: '50%',
      border: '1px solid', display: 'flex',
      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    itemLabel: { flex: 1, fontSize: 15 },
    cta: {
      fontFamily: 'var(--ed-mono)', fontSize: 11,
      letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer',
    },
  },

  kw: {
    wrap: { padding: '32px', borderTop: '1px solid var(--rule)' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22 },
    title: {
      margin: '6px 0 0', fontSize: 32, lineHeight: 1.05,
      fontStyle: 'italic', letterSpacing: '-0.01em', color: 'var(--paper)',
    },
    tag: {
      fontFamily: 'var(--ed-mono)', fontSize: 9.5,
      letterSpacing: '0.18em', padding: '3px 8px',
      color: 'var(--paper-mute)', border: '1px solid var(--rule-strong)', borderRadius: 2,
    },
    body: { display: 'grid', gridTemplateColumns: '1fr 280px', gap: 24, alignItems: 'stretch' },
    editorWrap: {
      display: 'flex', background: 'var(--ink-1)',
      border: '1px solid var(--rule)', minHeight: 240,
    },
    gutter: {
      padding: '14px 8px', borderRight: '1px solid var(--rule)',
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
      minWidth: 36, background: 'var(--ink-2)',
    },
    gutterNum: {
      fontFamily: 'var(--ed-mono)', fontSize: 11,
      color: 'var(--paper-faint)', lineHeight: '22px',
    },
    textarea: {
      flex: 1, background: 'transparent', border: 'none', outline: 'none',
      color: 'var(--paper)', padding: '14px 14px',
      fontFamily: 'var(--ed-mono)', fontSize: 13, lineHeight: '22px',
      resize: 'vertical', minHeight: 240,
    },
    controls: {
      display: 'flex', flexDirection: 'column', gap: 18,
      padding: 20, background: 'var(--ink-1)', border: '1px solid var(--rule)',
    },
    select: {
      width: '100%', background: 'var(--ink-2)',
      border: '1px solid var(--rule)', color: 'var(--paper)',
      padding: '8px 10px',
      fontFamily: 'var(--ed-mono)', fontSize: 12, borderRadius: 2,
    },
    checkRow: { display: 'flex', alignItems: 'center', gap: 10, color: 'var(--paper-dim)' },
    footer: {
      marginTop: 'auto', paddingTop: 18,
      borderTop: '1px dashed var(--rule)',
      display: 'flex', flexDirection: 'column', gap: 10,
    },
    go: {
      padding: '12px 14px', border: 'none',
      fontFamily: 'var(--ed-mono)', fontSize: 11,
      letterSpacing: '0.12em', textTransform: 'uppercase',
      borderRadius: 3, fontWeight: 600,
    },
  },

  feed: {
    wrap: { padding: '32px', borderTop: '1px solid var(--rule)' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, flexWrap: 'wrap', gap: 12 },
    tabs: { display: 'flex', gap: 0, border: '1px solid var(--rule)', borderRadius: 3 },
    tab: {
      background: 'transparent', color: 'var(--paper-mute)',
      border: 'none', padding: '6px 14px',
      fontFamily: 'var(--ed-mono)', fontSize: 11,
      letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
    },
    tabActive: { background: 'var(--ink-2)', color: 'var(--paper)' },
    list: { listStyle: 'none', padding: 0, margin: 0, borderTop: '1px solid var(--rule-strong)' },
    row: { borderBottom: '1px solid var(--rule)' },
    rowHead: {
      width: '100%', background: 'transparent', border: 'none',
      padding: '14px 4px',
      display: 'grid',
      gridTemplateColumns: '140px 110px 1fr auto 28px',
      gap: 16, alignItems: 'center', textAlign: 'left',
      cursor: 'pointer', color: 'var(--paper)',
    },
    tsCol: { fontSize: 11, color: 'var(--paper-dim)', letterSpacing: '0.04em' },
    statusChip: {
      fontFamily: 'var(--ed-mono)', fontSize: 9.5,
      letterSpacing: '0.16em', padding: '3px 8px',
      border: '1px solid', borderRadius: 2, justifySelf: 'start',
    },
    title: {
      fontSize: 19, fontStyle: 'italic', color: 'var(--paper)',
      letterSpacing: '-0.005em', lineHeight: 1.2,
      overflow: 'hidden', textOverflow: 'ellipsis',
      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    },
    scores: { display: 'flex', gap: 6 },
    scoreChip: {
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: 'var(--ink-2)', border: '1px solid var(--rule)',
      borderRadius: 2, padding: '2px 6px',
    },
    chev: {
      fontFamily: 'var(--ed-mono)', fontSize: 20,
      color: 'var(--paper-faint)', transition: 'transform .2s',
      display: 'inline-block', width: 12,
    },
    body: { padding: '0 4px 24px', display: 'flex', flexDirection: 'column', gap: 14 },
    bodyToolbar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    viewToggle: { display: 'flex', border: '1px solid var(--rule)', borderRadius: 3 },
    viewBtn: {
      background: 'transparent', border: 'none',
      padding: '6px 12px',
      fontFamily: 'var(--ed-mono)', fontSize: 11,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--paper-mute)', cursor: 'pointer',
    },
    viewBtnActive: { background: 'var(--ink-2)', color: 'var(--paper)' },
    minorBtn: {
      background: 'transparent', border: '1px solid var(--rule-strong)',
      padding: '6px 12px',
      fontFamily: 'var(--ed-mono)', fontSize: 11,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--paper-dim)', borderRadius: 3, cursor: 'pointer',
    },
    publishWrap: { display: 'inline-flex', alignItems: 'center' },
    preview: { padding: '20px 24px', background: 'var(--ink-0)', border: '1px solid var(--rule)' },
    previewLede: {
      fontFamily: 'var(--ed-serif)', fontSize: 18, lineHeight: 1.5,
      color: 'var(--paper-dim)', margin: '0 0 16px', maxWidth: '65ch',
      fontStyle: 'italic',
    },
    previewMeta: {
      display: 'flex', gap: 10, alignItems: 'center',
      paddingTop: 12, marginTop: 12,
      borderTop: '1px dashed var(--rule)',
      color: 'var(--paper-mute)', fontSize: 11,
    },
    raw: {
      background: 'var(--ink-0)', border: '1px solid var(--rule)',
      padding: 18, fontFamily: 'var(--ed-mono)', fontSize: 12,
      color: 'var(--paper-dim)', lineHeight: 1.6, margin: 0,
      overflowX: 'auto', maxHeight: 480,
      whiteSpace: 'pre-wrap',
    },
    loadMore: { textAlign: 'center', paddingTop: 24, marginTop: 12, borderTop: '1px solid var(--rule)' },
    loadBtn: {
      background: 'transparent', border: '1px solid var(--rule-strong)',
      padding: '10px 22px',
      fontFamily: 'var(--ed-mono)', fontSize: 11,
      letterSpacing: '0.12em', textTransform: 'uppercase',
      color: 'var(--paper-dim)', borderRadius: 3, cursor: 'pointer',
    },
  },

  col: {
    wrap: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '28px 32px',
      borderTop: '3px double var(--rule-strong)',
      marginTop: 40, flexWrap: 'wrap', gap: 16,
    },
    row: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  },
};
