// Phase 4 dashboard — keyword form, jobs queue, articles list.
//
// Inserts a row into public.jobs; the worker (engine/src/worker.ts)
// picks it up. We poll every 4s for status updates because Supabase
// Realtime is fine for a queue this small but adds another wire to
// debug — pollg keeps things obvious for now.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';
import PublishControls from '../components/PublishControls.jsx';
import OnboardingChecklist from '../components/OnboardingChecklist.jsx';
import { regenerateArticle, retryJob } from '../lib/jobs.js';

const POLL_MS = 4000;

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

// Free-trial heads-up shown at the top of the dashboard when the
// active subscription is a Pilot. Surfaces days/articles left and a
// direct upgrade CTA so the user understands the trial is finite and
// where to go when they want more. Once the period_end is in the past
// the enforce_jobs_quota trigger already blocks new jobs — this just
// makes the state visible before the user hits that wall.
function PilotTrialBanner({ sub }) {
  const remaining = Math.max(0, sub.articles_quota - sub.articles_used_this_period);
  const endMs = new Date(sub.current_period_end).getTime();
  const daysLeft = Math.max(0, Math.ceil((endMs - Date.now()) / (24 * 60 * 60 * 1000)));
  const expired = daysLeft === 0 || remaining === 0;
  return (
    <div
      className="app-callout"
      style={{
        marginTop: 24,
        borderColor: expired ? 'var(--accent-ring)' : undefined,
        background: expired ? 'var(--accent-faint)' : undefined,
      }}
    >
      <div>
        <div className="eyebrow" style={{ marginBottom: 8 }}>
          {expired ? 'Trial ended' : 'Free trial'}
        </div>
        <p className="app-callout-p">
          {expired ? (
            <>You've used your free trial. Upgrade to keep generating verified articles.</>
          ) : (
            <>
              <strong>{remaining}</strong> {remaining === 1 ? 'article' : 'articles'} and{' '}
              <strong>{daysLeft}</strong> {daysLeft === 1 ? 'day' : 'days'} left in your trial.
              Upgrade anytime to keep going.
            </>
          )}
        </p>
      </div>
      <Link to="/app/pricing" className="btn btn-primary" style={{ marginLeft: 'auto' }}>
        Upgrade <ArrowRight />
      </Link>
    </div>
  );
}

function StatusChip({ status }) {
  const map = {
    queued: { label: 'Queued', cls: 'chip chip-faint' },
    running: { label: 'Running…', cls: 'chip chip-warn' },
    completed: { label: 'Done', cls: 'chip' },
    failed: { label: 'Failed', cls: 'chip chip-warn' },
    draft: { label: 'Draft', cls: 'chip' },
    published: { label: 'Published', cls: 'chip chip-accent' },
  };
  const m = map[status] ?? { label: status, cls: 'chip' };
  return <span className={m.cls}>{m.label}</span>;
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
  return new Date(iso).toLocaleDateString();
}

export default function Dashboard() {
  const { user, profile, signOut } = useAuth();
  const toast = useToast();

  const [keyword, setKeyword] = useState('');
  const [voiceId, setVoiceId] = useState(''); // optional voice attached to the job
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [articles, setArticles] = useState([]);
  const [subscription, setSubscription] = useState(null);
  const [sites, setSites] = useState([]);
  const [voices, setVoices] = useState([]);
  const [openArticleId, setOpenArticleId] = useState(null);

  const displayName =
    profile?.full_name ||
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'there';

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !user) return;
    const [jobsRes, articlesRes, subRes, sitesRes, voicesRes] = await Promise.all([
      supabase
        .from('jobs')
        .select('id, keyword, status, error, created_at, completed_at, article_id')
        .order('created_at', { ascending: false })
        .limit(20),
      supabase
        .from('articles')
        .select('id, keyword, title, meta_description, body_markdown, pass_rate, status, generated_at, receipts, cms_post_url, cms_post_id, site_id, published_at')
        .order('generated_at', { ascending: false })
        .limit(20),
      supabase
        .from('subscriptions')
        .select('plan, status, articles_used_this_period, articles_quota, current_period_end')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('sites')
        .select('id, name, cms_type, is_active')
        .eq('is_active', true)
        .order('name'),
      supabase
        .from('voices')
        .select('id, source_url, created_at')
        .order('created_at', { ascending: false }),
    ]);
    setJobs(jobsRes.data ?? []);
    setArticles(articlesRes.data ?? []);
    setSubscription(subRes.data ?? null);
    setSites(sitesRes.data ?? []);
    setVoices(voicesRes.data ?? []);
  }, [user]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const activeSub =
    subscription &&
    (subscription.status === 'active' || subscription.status === 'trialing')
      ? subscription
      : null;
  const remaining = activeSub
    ? Math.max(0, activeSub.articles_quota - activeSub.articles_used_this_period)
    : 0;
  const canSubmit = activeSub && remaining > 0 && keyword.trim().length >= 3 && !submitting;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    const { error } = await supabase.from('jobs').insert({
      user_id: user.id,
      keyword: keyword.trim(),
      voice_id: voiceId || null,
    });
    setSubmitting(false);
    if (error) {
      // Quota / no-subscription errors are surfaced by the BEFORE INSERT trigger.
      const msg = error.message || 'Could not enqueue job.';
      if (msg.includes('quota_exceeded')) {
        toast('Quota exhausted for this period. Upgrade or wait for renewal.', { tone: 'danger' });
      } else if (msg.includes('no_active_subscription')) {
        toast('Subscribe to a plan before generating articles.', { tone: 'danger' });
      } else {
        toast(msg, { tone: 'danger' });
      }
      return;
    }
    setKeyword('');
    toast('Job queued. The worker will pick it up shortly.', { tone: 'success' });
    load();
  };

  // Merge jobs + articles into one chronological list. A completed job's
  // article shows up via its article_id; jobs without an article (queued,
  // running, failed) show as in-progress rows.
  const articleById = useMemo(() => {
    const m = new Map();
    for (const a of articles) m.set(a.id, a);
    return m;
  }, [articles]);

  const rows = useMemo(() => {
    const seenArticleIds = new Set();
    const out = [];
    for (const j of jobs) {
      if (j.article_id && articleById.has(j.article_id)) {
        const a = articleById.get(j.article_id);
        seenArticleIds.add(a.id);
        out.push({ kind: 'article', job: j, article: a, ts: a.generated_at });
      } else {
        out.push({ kind: 'job', job: j, ts: j.created_at });
      }
    }
    // Articles created before jobs existed (or orphaned) — show too.
    for (const a of articles) {
      if (!seenArticleIds.has(a.id)) {
        out.push({ kind: 'article', article: a, ts: a.generated_at });
      }
    }
    out.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    return out;
  }, [jobs, articles, articleById]);

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
            {activeSub && (
              <span className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                {activeSub.articles_used_this_period}/{activeSub.articles_quota} this period
              </span>
            )}
            <Link to="/app/settings" className="app-nav-email">{user?.email}</Link>
            <button type="button" className="btn btn-sm btn-ghost" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="app-container">
          <div className="eyebrow" style={{ marginBottom: 14 }}>Articles</div>
          <h1 className="app-h1 serif">
            Hi, <span className="hero-h1-em">{displayName.split(' ')[0]}</span>.
          </h1>
          <p className="app-lede">
            Type a keyword. Bylined sources, drafts, and verifies an article — then it
            shows up below.
          </p>

          {activeSub && activeSub.plan === 'pilot' && (
            <PilotTrialBanner sub={activeSub} />
          )}

          {activeSub && (
            <OnboardingChecklist
              sites={sites}
              voices={voices}
              hasArticles={articles.length > 0}
              userId={user.id}
            />
          )}

          {!activeSub ? (
            <div className="app-callout" style={{ marginTop: 24 }}>
              <div>
                <div className="eyebrow" style={{ marginBottom: 8 }}>No active plan</div>
                <p className="app-callout-p">
                  Subscribe to a plan to start generating articles.
                </p>
              </div>
              <Link to="/app/pricing" className="btn btn-primary" style={{ marginLeft: 'auto' }}>
                See plans <ArrowRight />
              </Link>
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="app-callout"
              style={{
                marginTop: 24,
                gap: 12,
                alignItems: 'stretch',
                flexDirection: 'column',
              }}
            >
              <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="best email marketing platforms for shopify stores 2026"
                  className="input"
                  style={{ flex: 1, minWidth: 220 }}
                  disabled={submitting || remaining === 0}
                  maxLength={200}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!canSubmit}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {submitting
                    ? 'Queueing…'
                    : remaining === 0
                    ? 'Quota used'
                    : 'Generate'}{' '}
                  {!submitting && remaining > 0 && <ArrowRight />}
                </button>
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                }}
              >
                <span>Voice:</span>
                <select
                  className="input"
                  value={voiceId}
                  onChange={(e) => setVoiceId(e.target.value)}
                  disabled={submitting || voices.length === 0}
                  style={{ width: 'auto', minWidth: 200, height: 28, fontSize: 12.5 }}
                >
                  <option value="">No voice (generic style)</option>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {new URL(v.source_url).hostname}
                    </option>
                  ))}
                </select>
                {voices.length === 0 && (
                  <span>
                    <Link to="/app/voice">Extract a voice</Link> for branded
                    output.
                  </span>
                )}
              </div>
            </form>
          )}

          {activeSub && remaining === 0 && (
            <p className="app-fineprint" style={{ marginTop: 12, color: 'var(--fg-muted)' }}>
              You've used all {activeSub.articles_quota} articles this period. Renews{' '}
              {new Date(activeSub.current_period_end).toLocaleDateString()}.{' '}
              <Link to="/app/billing">Upgrade</Link> for a higher quota.
            </p>
          )}

          <div style={{ marginTop: 40 }}>
            <div className="eyebrow" style={{ marginBottom: 12 }}>Recent</div>
            {rows.length === 0 ? (
              <div className="app-callout">
                <div style={{ color: 'var(--fg-muted)' }}>
                  No articles yet. Submit a keyword above to get started.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {rows.map((r) => (
                  <ArticleRow
                    key={r.kind === 'article' ? `a-${r.article.id}` : `j-${r.job.id}`}
                    row={r}
                    isOpen={r.kind === 'article' && openArticleId === r.article.id}
                    onToggle={() =>
                      r.kind === 'article'
                        ? setOpenArticleId(
                            openArticleId === r.article.id ? null : r.article.id
                          )
                        : null
                    }
                    sites={sites}
                    userId={user.id}
                    onChanged={load}
                    toast={toast}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function ArticleRow({ row, isOpen, onToggle, sites, userId, onChanged, toast }) {
  if (row.kind === 'job') {
    const j = row.job;
    const isFailed = j.status === 'failed';
    return (
      <div className="app-tile" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <StatusChip status={j.status} />
          <div style={{ flex: 1, minWidth: 0, color: 'var(--fg)' }}>
            <div style={{ fontWeight: 500 }}>{j.keyword}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {relTime(j.created_at)}
            </div>
          </div>
          {isFailed && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const result = await retryJob(j.id);
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
          )}
        </div>
        {isFailed && j.error && (
          <div
            className="mono"
            style={{
              marginTop: 10,
              fontSize: 12,
              color: 'var(--fg-muted)',
              background: 'rgba(255,255,255,0.04)',
              padding: '8px 10px',
              borderRadius: 6,
              whiteSpace: 'pre-wrap',
            }}
          >
            {j.error}
          </div>
        )}
      </div>
    );
  }

  const a = row.article;
  const verified = (a.receipts ?? []).filter((r) => r.verified).length;
  const total = (a.receipts ?? []).length;
  const isPublished = a.status === 'published' && a.cms_post_url;

  return (
    <div className="app-tile" style={{ padding: 16 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          color: 'inherit',
          flexWrap: 'wrap',
        }}
      >
        <StatusChip status={isPublished ? 'published' : 'completed'} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: 'var(--fg)' }}>{a.title}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
            {a.keyword} · {relTime(a.generated_at)}
            {isPublished && a.published_at && ` · published ${relTime(a.published_at)}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            {verified}/{total} cites · {((a.pass_rate ?? 0) * 100).toFixed(0)}%
          </span>
        </div>
      </button>
      {isOpen && (
        <div style={{ marginTop: 16 }}>
          {a.meta_description && (
            <p style={{ color: 'var(--fg-muted)', fontStyle: 'italic', marginBottom: 12 }}>
              {a.meta_description}
            </p>
          )}
          <pre
            style={{
              background: 'rgba(255,255,255,0.03)',
              padding: 14,
              borderRadius: 8,
              maxHeight: 420,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              fontSize: 13,
              lineHeight: 1.55,
              color: 'var(--fg)',
            }}
          >
            {a.body_markdown}
          </pre>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <Link to={`/app/articles/${a.id}`} className="btn btn-sm">
              Open detail →
            </Link>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                navigator.clipboard.writeText(a.body_markdown);
                toast('Markdown copied', { tone: 'success' });
              }}
            >
              Copy markdown
            </button>
            <PublishControls
              article={a}
              sites={sites}
              onPublished={onChanged}
              toast={toast}
            />
            {isPublished && (
              <a
                href={a.cms_post_url}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm"
              >
                View on site →
              </a>
            )}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={async () => {
                if (
                  !confirm(
                    'Regenerate? Queues a fresh job (same keyword + voice) and counts as one article against your quota.'
                  )
                )
                  return;
                const result = await regenerateArticle(a, userId);
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
          </div>
        </div>
      )}
    </div>
  );
}
