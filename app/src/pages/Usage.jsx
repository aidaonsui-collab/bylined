// Usage — customer-value dashboard.
//
// What this page is NOT: a COGS dashboard. We used to show Bylined's
// raw LLM/SERP costs here, which made it look like we were marking up
// fractions of a cent into $99/mo subscriptions. That was internal
// data leaking into a customer-facing page.
//
// What this page IS: a snapshot of what the customer got for their
// subscription this period — how many articles, how many citations
// verified, how many landed on their site.
//
// All counts pulled from public.articles (RLS-scoped to the user) and
// public.subscriptions (period bounds + quota). No cost tables touched.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import AppNav from '../components/AppNav.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${Math.round(n * 100)}%`;
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

// Friendly status chip. Maps the internal article.status enum into the
// label the customer cares about.
function StatusChip({ status, hasPublishedUrl }) {
  if (status === 'published' && hasPublishedUrl) {
    return <span className="chip chip-accent">Live</span>;
  }
  if (status === 'failed') return <span className="chip chip-danger">Failed</span>;
  if (status === 'scheduled') return <span className="chip">Scheduled</span>;
  return <span className="chip">Draft</span>;
}

export default function Usage() {
  const { user, signOut } = useAuth();
  const [loading, setLoading] = useState(true);
  const [subscription, setSubscription] = useState(null);
  // articles is the paginated table; metricsArticles is the full
  // current-period set (slim columns) used for the headline counters
  // so they don't quietly understate when the customer is past 25 rows.
  const [articles, setArticles] = useState([]);
  const [metricsArticles, setMetricsArticles] = useState([]);
  const [articleLimit, setArticleLimit] = useState(25);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !user) {
      setLoading(false);
      return;
    }

    // Active subscription — quota + period bounds. current_period_start
    // is what scopes the article queries below: without it the page
    // would silently show the last N articles across all periods,
    // which was the previous bug.
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

    // Period boundary for both article queries. If the customer has no
    // active subscription (free trial, expired plan) fall back to the
    // last 30 days so the page isn't blank.
    const periodStart =
      sub?.current_period_start ??
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Two parallel article queries:
    //   • full set (slim columns, cap 500) for the headline aggregates
    //   • paginated set (full columns) for the table itself
    const [metricsRes, listRes] = await Promise.all([
      supabase
        .from('articles')
        .select('id, status, pass_rate, receipts, cms_post_url')
        .gte('generated_at', periodStart)
        .order('generated_at', { ascending: false })
        .limit(500),
      supabase
        .from('articles')
        .select(
          'id, title, keyword, status, pass_rate, receipts, cms_post_url, published_at, generated_at'
        )
        .gte('generated_at', periodStart)
        .order('generated_at', { ascending: false })
        .limit(articleLimit),
    ]);
    setMetricsArticles(metricsRes.data ?? []);
    setArticles(listRes.data ?? []);

    setLoading(false);
  }, [user, articleLimit]);

  useEffect(() => {
    load();
  }, [load]);

  const articlesThisPeriod = subscription?.articles_used_this_period ?? 0;
  const quota = subscription?.articles_quota ?? 0;

  // Aggregate citation pass rate across all current-period articles
  // (event-weighted by citation count, not article-weighted — one
  // 50-cite article matters more than one 3-cite article).
  const citationStats = useMemo(() => {
    let pass = 0;
    let total = 0;
    for (const a of metricsArticles) {
      const cites = a.receipts ?? [];
      total += cites.length;
      pass += cites.filter((r) => r.verified).length;
    }
    return { pass, total, rate: total > 0 ? pass / total : null };
  }, [metricsArticles]);

  const publishedCount = useMemo(
    () =>
      metricsArticles.filter((a) => a.status === 'published' && a.cms_post_url)
        .length,
    [metricsArticles]
  );
  const periodArticleCount = metricsArticles.length;

  return (
    <div className="app-shell">
      <AppNav />

      <main className="app-main">
        <div className="app-container">
          <div className="eyebrow" style={{ marginBottom: 14 }}>Usage</div>
          <h1 className="app-h1 serif">Your articles this period</h1>
          <p className="app-lede">
            What your subscription got you — articles generated, citations
            verified, posts published. Resets every billing cycle.
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
              label="Articles this period"
              primary={`${articlesThisPeriod} / ${quota || '—'}`}
              sub={
                quota > 0
                  ? `${Math.max(0, quota - articlesThisPeriod)} remaining`
                  : 'no active plan'
              }
            />
            <SummaryCard
              label="Citation pass rate"
              primary={fmtPct(citationStats.rate)}
              sub={
                citationStats.total > 0
                  ? `${fmtCount(citationStats.pass)} of ${fmtCount(citationStats.total)} verified`
                  : 'no citations yet'
              }
            />
            <SummaryCard
              label="Published live"
              primary={`${publishedCount} of ${periodArticleCount}`}
              sub={
                periodArticleCount === 0
                  ? '—'
                  : publishedCount === periodArticleCount
                    ? 'everything is live'
                    : 'the rest are drafts'
              }
            />
            <SummaryCard
              label="Period resets"
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

          {/* ─── Per-article table ──────────────────────────────── */}
          <div style={{ marginTop: 40 }}>
            <div className="eyebrow" style={{ marginBottom: 12 }}>
              Recent articles
            </div>
            {loading ? (
              <div className="app-callout"><div>Loading…</div></div>
            ) : articles.length === 0 ? (
              <div className="app-callout">
                <div style={{ color: 'var(--fg-muted)' }}>
                  Nothing generated yet. Head to{' '}
                  <Link to="/app">Articles</Link> to write your first one.
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
                      <Th>Generated</Th>
                      <Th>Status</Th>
                      <Th right>Citations</Th>
                      <Th>Where</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {articles.map((a) => {
                      const cites = a.receipts ?? [];
                      const verified = cites.filter((r) => r.verified).length;
                      return (
                        <tr key={a.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <Td left>
                            <div style={{ fontWeight: 500, color: 'var(--fg)' }}>
                              {a.title ?? '(untitled)'}
                            </div>
                            {a.keyword && (
                              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
                                {a.keyword}
                              </div>
                            )}
                          </Td>
                          <Td>{shortDate(a.generated_at)}</Td>
                          <Td>
                            <StatusChip
                              status={a.status}
                              hasPublishedUrl={!!a.cms_post_url}
                            />
                          </Td>
                          <Td right mono>
                            {cites.length > 0
                              ? `${verified}/${cites.length} · ${fmtPct(a.pass_rate)}`
                              : '—'}
                          </Td>
                          <Td>
                            {a.cms_post_url ? (
                              <a
                                href={a.cms_post_url}
                                target="_blank"
                                rel="noreferrer noopener"
                                style={{ color: 'var(--accent-text)', textDecoration: 'underline', textUnderlineOffset: 2 }}
                              >
                                {a.status === 'published' ? 'View live ↗' : 'View draft ↗'}
                              </a>
                            ) : (
                              <span style={{ color: 'var(--fg-subtle)' }}>—</span>
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {articles.length >= articleLimit &&
              articles.length < periodArticleCount && (
                <div style={{ marginTop: 14, textAlign: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setArticleLimit((n) => n + 25)}
                  >
                    Load more ({periodArticleCount - articles.length} remaining)
                  </button>
                </div>
              )}
            <p className="app-fineprint" style={{ marginTop: 14, fontSize: 12, color: 'var(--fg-subtle)' }}>
              Articles count toward your monthly quota the moment they're
              generated — drafts and published posts both count. Citations
              are URL-verified at generation time and the pass rate
              reflects how many of those re-fetches succeeded.
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
