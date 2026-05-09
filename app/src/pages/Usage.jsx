// Usage — COGS dashboard.
//
// Reads from public.cost_events + the cost_per_article and
// cost_per_user_day views. RLS scopes everything to the calling user,
// so this page is safe under the authenticated client without any
// edge-function involvement.
//
// What we show:
//   1. This-period summary cards (mirrors articles_used / quota from
//      subscriptions, plus total + per-article spend).
//   2. 14-day daily-spend bar chart (rendered as inline SVG — no
//      charting library since the data shape is small and we already
//      ship enough JS).
//   3. Per-article breakdown table — total cost + LLM/SERP/page/verify
//      split + event count per article, joined to articles for title.
//
// The dashboard is intentionally COGS-focused (what Bylined spends to
// generate articles for this user), not customer-facing pricing. Useful
// while we tune margins; if it ever ships to end users we'll reframe
// the numbers.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';

const Logo = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4 L8 12 L14 20" />
    <circle cx="14" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="14" cy="20" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

// Round to a reasonable USD display: <$1 → 4 decimals, ≥$1 → 2.
function fmtUsd(n) {
  const v = Number(n ?? 0);
  if (v === 0) return '$0';
  if (v < 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function fmtCount(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Build a 14-day backfilled timeseries: every day appears even if the
// view returned no row for it. We prefer empty bars to gaps so the
// trend reads cleanly.
function buildDailySeries(rows, days = 14) {
  const byDay = new Map();
  for (const r of rows ?? []) {
    const day = r.day.slice(0, 10);
    byDay.set(day, Number(r.total_cost_usd ?? 0));
  }
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, cost: byDay.get(key) ?? 0 });
  }
  return out;
}

function SparkBar({ series }) {
  const max = Math.max(0, ...series.map((d) => d.cost));
  const W = 100; // viewBox width
  const H = 30;
  const barW = W / series.length;
  const pad = 1;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={56}
      style={{ display: 'block' }}
      aria-label="Daily spend, last 14 days"
    >
      {series.map((d, i) => {
        const h = max > 0 ? (d.cost / max) * (H - 2) : 0;
        return (
          <rect
            key={d.day}
            x={i * barW + pad / 2}
            y={H - h}
            width={barW - pad}
            height={Math.max(h, 0.5)}
            fill={d.cost > 0 ? 'var(--accent)' : 'var(--border-2)'}
            opacity={d.cost > 0 ? 0.85 : 0.5}
          >
            <title>{`${d.day}: ${fmtUsd(d.cost)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export default function Usage() {
  const { user, signOut } = useAuth();
  const [loading, setLoading] = useState(true);
  const [subscription, setSubscription] = useState(null);
  const [perArticle, setPerArticle] = useState([]);
  const [perDay, setPerDay] = useState([]);
  const [periodTotals, setPeriodTotals] = useState({
    total_cost: 0,
    event_count: 0,
  });

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !user) {
      setLoading(false);
      return;
    }

    // Fetch the active subscription first so we know the period bounds.
    const { data: sub } = await supabase
      .from('subscriptions')
      .select(
        'plan, status, articles_used_this_period, articles_quota, current_period_start, current_period_end'
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setSubscription(sub ?? null);

    // 14 days of daily totals (RLS-scoped via the view).
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 14);
    const { data: days } = await supabase
      .from('cost_per_user_day')
      .select('day, event_count, total_cost_usd, input_tokens, output_tokens')
      .gte('day', since.toISOString())
      .order('day', { ascending: true });
    setPerDay(days ?? []);

    // Per-article rollup. Views don't reliably auto-embed via PostgREST,
    // so we fetch the matching articles separately and merge client-side.
    const { data: pa } = await supabase
      .from('cost_per_article')
      .select(
        'article_id, event_count, total_cost_usd, llm_cost_usd, ' +
          'serp_cost_usd, page_fetch_cost_usd, verify_cost_usd, last_event_at'
      )
      .order('last_event_at', { ascending: false })
      .limit(50);
    if (pa && pa.length > 0) {
      const ids = pa.map((r) => r.article_id);
      const { data: articles } = await supabase
        .from('articles')
        .select('id, title, keyword, generated_at, status')
        .in('id', ids);
      const byId = new Map((articles ?? []).map((a) => [a.id, a]));
      setPerArticle(pa.map((r) => ({ ...r, article: byId.get(r.article_id) })));
    } else {
      setPerArticle([]);
    }

    // Total spend within the current billing period.
    if (sub?.current_period_start) {
      const { data: sums } = await supabase
        .from('cost_events')
        .select('cost_usd')
        .gte('created_at', sub.current_period_start);
      const cost = (sums ?? []).reduce(
        (s, r) => s + Number(r.cost_usd ?? 0),
        0
      );
      setPeriodTotals({ total_cost: cost, event_count: (sums ?? []).length });
    }

    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const series = useMemo(() => buildDailySeries(perDay, 14), [perDay]);

  const articlesThisPeriod = subscription?.articles_used_this_period ?? 0;
  const quota = subscription?.articles_quota ?? 0;
  const avgPerArticle =
    articlesThisPeriod > 0 ? periodTotals.total_cost / articlesThisPeriod : 0;

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
            <span className="app-nav-email">{user?.email}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="app-container">
          <div className="eyebrow" style={{ marginBottom: 14 }}>Usage</div>
          <h1 className="app-h1 serif">Spend & generation history</h1>
          <p className="app-lede">
            What it costs Bylined to produce your articles. Tracks every LLM
            call, SERP query, page fetch, and citation re-fetch.
          </p>

          {/* ─── Period summary cards ───────────────────────────── */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 12,
              marginTop: 32,
            }}
          >
            <SummaryCard
              label="This period"
              primary={`${articlesThisPeriod} / ${quota || '—'}`}
              sub="articles used"
            />
            <SummaryCard
              label="Spend (period)"
              primary={fmtUsd(periodTotals.total_cost)}
              sub={`${periodTotals.event_count} events`}
            />
            <SummaryCard
              label="Avg per article"
              primary={fmtUsd(avgPerArticle)}
              sub={
                articlesThisPeriod > 0
                  ? `over ${articlesThisPeriod} ${
                      articlesThisPeriod === 1 ? 'article' : 'articles'
                    }`
                  : '—'
              }
            />
            <SummaryCard
              label="Period ends"
              primary={
                subscription?.current_period_end
                  ? new Date(
                      subscription.current_period_end
                    ).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })
                  : '—'
              }
              sub={subscription?.plan ? `${subscription.plan} plan` : ''}
            />
          </div>

          {/* ─── Daily trend ────────────────────────────────────── */}
          <div style={{ marginTop: 40 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              <div className="eyebrow">Daily spend</div>
              <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                last 14 days
              </span>
            </div>
            <div className="app-callout" style={{ flexDirection: 'column', alignItems: 'stretch', padding: 16 }}>
              <SparkBar series={series} />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: 8,
                  fontSize: 11,
                  color: 'var(--fg-subtle)',
                }}
              >
                <span>{shortDate(series[0]?.day)}</span>
                <span>{shortDate(series[series.length - 1]?.day)}</span>
              </div>
            </div>
          </div>

          {/* ─── Per-article table ──────────────────────────────── */}
          <div style={{ marginTop: 40 }}>
            <div className="eyebrow" style={{ marginBottom: 12 }}>
              Per article
            </div>
            {loading ? (
              <div className="app-callout"><div>Loading…</div></div>
            ) : perArticle.length === 0 ? (
              <div className="app-callout">
                <div style={{ color: 'var(--fg-muted)' }}>
                  No cost data yet. Generate an article from{' '}
                  <Link to="/app">/app</Link> to see costs land here.
                </div>
              </div>
            ) : (
              <div
                className="app-callout"
                style={{ flexDirection: 'column', alignItems: 'stretch', padding: 0, overflow: 'hidden' }}
              >
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
                      <Th left>Article</Th>
                      <Th>When</Th>
                      <Th right>Total</Th>
                      <Th right>LLM</Th>
                      <Th right>Verify</Th>
                      <Th right>Events</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {perArticle.map((r) => {
                      const a = r.article;
                      return (
                        <tr key={r.article_id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <Td left>
                            <div style={{ fontWeight: 500, color: 'var(--fg)' }}>
                              {a?.title ?? '(deleted)'}
                            </div>
                            {a?.keyword && (
                              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
                                {a.keyword}
                              </div>
                            )}
                          </Td>
                          <Td>{shortDate(r.last_event_at)}</Td>
                          <Td right mono>{fmtUsd(r.total_cost_usd)}</Td>
                          <Td right mono>{fmtUsd(r.llm_cost_usd)}</Td>
                          <Td right mono>{fmtUsd(r.verify_cost_usd)}</Td>
                          <Td right mono>{fmtCount(r.event_count)}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="app-fineprint" style={{ marginTop: 14, fontSize: 12, color: 'var(--fg-subtle)' }}>
              "LLM" includes extraction, generation, and voice fingerprint
              calls. "Verify" is the per-citation URL re-fetches in the
              validation gate. SERP and page fetches are free with the
              current providers.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function SummaryCard({ label, primary, sub }) {
  return (
    <div
      className="app-callout"
      style={{
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
        padding: 16,
      }}
    >
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ fontSize: 22, color: 'var(--fg)', fontWeight: 600, letterSpacing: '-0.01em' }}>
        {primary}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{sub}</div>
      )}
    </div>
  );
}

function Th({ children, left, right }) {
  return (
    <th
      style={{
        textAlign: left ? 'left' : right ? 'right' : 'left',
        padding: '10px 14px',
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--fg-subtle)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, left, right, mono }) {
  return (
    <td
      style={{
        textAlign: left ? 'left' : right ? 'right' : 'left',
        padding: '12px 14px',
        verticalAlign: 'middle',
        color: 'var(--fg)',
        fontFamily: mono ? 'var(--font-mono)' : 'inherit',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {children}
    </td>
  );
}
