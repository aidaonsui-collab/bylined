// /app dashboard — the "newsroom".
//
// Page is a thin shell: it owns data loading (jobs, articles, sub, sites,
// voices) and the submit handler that enqueues new jobs, then hands
// everything to the editorial components in EditorialDashboard.jsx.
//
// The previous (non-editorial) DashboardOverview + AppNav are no longer
// rendered here; Masthead replaces AppNav and the editorial pieces
// replace the old status strip / gauge / pillars / tasks / form /
// recent list. Polling, bulk submit, quota gates, regenerate/retry,
// and PublishControls behavior are all preserved.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';
import {
  Masthead,
  TrialBanner,
  StatusStrip,
  HealthGauge,
  QualityPillars,
  TasksList,
  VisibilityChartEditorial,
  Onboarding,
  KeywordForm,
  RecentFeed,
  Colophon,
  computePillars,
  computeTasks,
  healthNote,
  pickOrgName,
  formatVoiceLabel,
} from '../components/EditorialDashboard.jsx';

const POLL_MS = 4000;
const WINDOW_DAYS = 30;
const MAX_BULK = 50;
// Drip duration when the user ticks "Drip over the month" on a bulk
// paste. First row releases now, last row releases at +DRIP_DAYS days,
// linear spacing in between. Lifted to module scope so the form
// callout copy can show it without prop drilling magic numbers.
const DRIP_DAYS = 30;

export default function Dashboard() {
  const { user } = useAuth();
  const toast = useToast();

  // ── form state (owned here so it survives re-mounts during polls) ──
  const [keyword, setKeyword] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [autoPublishSiteId, setAutoPublishSiteId] = useState('');
  const [autoPublishLive, setAutoPublishLive] = useState(true);
  // Drip = spread this batch's release_at timestamps over 30 days so
  // the user can paste once and have articles publish over the month.
  // Default OFF — keeps "Generate now" behavior identical to today.
  // Only meaningful when the paste is 2+ keywords.
  const [dripOverMonth, setDripOverMonth] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ── data ──
  const [jobs, setJobs] = useState([]);
  const [articles, setArticles] = useState([]);
  // Two 30d windows so we can show pillar deltas (curr vs prior).
  const [recentMetrics, setRecentMetrics] = useState([]);
  const [priorMetrics, setPriorMetrics] = useState([]);
  const [articleLimit, setArticleLimit] = useState(20);
  const [subscription, setSubscription] = useState(null);
  const [sites, setSites] = useState([]);
  const [voices, setVoices] = useState([]);
  // Per-voice quality aggregates from the voice_strengths view
  // (security-invoker, RLS-scoped). Keyed by voice_id so KeywordForm
  // can show a strength chip next to each dropdown option.
  const [voiceStrengths, setVoiceStrengths] = useState({});
  // Real visibility_snapshots rows for this user. When empty, the
  // chart falls back to the deterministic mock (with a PREVIEW chip).
  // First real row lands once the cron fires (daily 06:00 UTC) AND
  // PERPLEXITY_API_KEY is set on the run-visibility-check function.
  const [visibilitySnapshots, setVisibilitySnapshots] = useState([]);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !user) return;
    const now = Date.now();
    const thirtyDaysAgo = new Date(now - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const sixtyDaysAgo = new Date(now - 2 * WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const [
      jobsRes,
      articlesRes,
      recentRes,
      priorRes,
      subRes,
      sitesRes,
      voicesRes,
    ] = await Promise.all([
      supabase
        .from('jobs')
        .select(
          'id, keyword, status, error, created_at, completed_at, article_id, ' +
            'release_at, drip_batch_id, drip_position',
        )
        .order('created_at', { ascending: false })
        .limit(40),
      supabase
        .from('articles')
        .select(
          'id, keyword, title, meta_description, body_markdown, pass_rate, aeo_score, voice_match_score, status, generated_at, receipts, cms_post_url, cms_post_id, site_id, published_at',
        )
        .order('generated_at', { ascending: false })
        .limit(articleLimit),
      supabase
        .from('articles')
        .select('id, status, pass_rate, aeo_score, voice_match_score, generated_at')
        .gte('generated_at', thirtyDaysAgo)
        .order('generated_at', { ascending: false })
        .limit(500),
      supabase
        .from('articles')
        .select('id, pass_rate, aeo_score, voice_match_score, generated_at')
        .gte('generated_at', sixtyDaysAgo)
        .lt('generated_at', thirtyDaysAgo)
        .order('generated_at', { ascending: false })
        .limit(500),
      supabase
        .from('subscriptions')
        .select('plan, status, articles_used_this_period, articles_quota, current_period_end')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('sites')
        .select('id, name, cms_type, is_active, voice_id')
        .eq('is_active', true)
        .order('name'),
      supabase
        .from('voices')
        .select('id, source_url, created_at')
        .order('created_at', { ascending: false }),
    ]);

    setJobs(jobsRes.data ?? []);
    setArticles(articlesRes.data ?? []);
    setRecentMetrics(recentRes.data ?? []);
    setPriorMetrics(priorRes.data ?? []);
    setSubscription(subRes.data ?? null);
    setSites(sitesRes.data ?? []);
    setVoices(voicesRes.data ?? []);

    // Separate fetch — voice_strengths is a view, can't be batched
    // into the Promise.all above without an awkward shape change.
    // Cheap query (1 row per voice), so a serial call is fine.
    const { data: strengthRows } = await supabase
      .from('voice_strengths')
      .select('voice_id, articles_scored, avg_voice_match');
    const byId = {};
    for (const s of strengthRows ?? []) byId[s.voice_id] = s;
    setVoiceStrengths(byId);

    // Visibility snapshots are tiny (one row/week) — pull the last 26
    // weeks so the chart has half a year of history when it exists.
    const { data: snapshotRows } = await supabase
      .from('visibility_snapshots')
      .select(
        'week_number, snapshot_date, perplexity_citations, chatgpt_citations, claude_citations, questions_asked',
      )
      .order('week_number', { ascending: true })
      .limit(26);
    setVisibilitySnapshots(snapshotRows ?? []);
  }, [user, articleLimit]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Default the auto-publish dropdown to the user's first active site
  // when sites first load. Without this, the form defaults to "None"
  // and bulk submissions silently land as drafts — which surprised the
  // user once already (May 17 bulk of 18 → all draft). The ref ensures
  // we only apply the default once per session, so if the user
  // explicitly clears it back to "None" we don't override on the next
  // poll-driven sites refresh.
  const sitesDefaultApplied = useRef(false);
  useEffect(() => {
    if (sitesDefaultApplied.current) return;
    if (sites.length > 0 && autoPublishSiteId === '') {
      setAutoPublishSiteId(sites[0].id);
      sitesDefaultApplied.current = true;
    }
  }, [sites, autoPublishSiteId]);

  // ── derived ──
  const activeSub =
    subscription && (subscription.status === 'active' || subscription.status === 'trialing')
      ? subscription
      : null;

  const remaining = activeSub
    ? Math.max(0, activeSub.articles_quota - activeSub.articles_used_this_period)
    : 0;

  const parsedKeywords = keyword
    .split('\n')
    .map((k) => k.trim())
    .filter((k) => k.length >= 3);
  const keywordCount = parsedKeywords.length;
  const overCap = keywordCount > MAX_BULK;
  const overQuota = !!activeSub && keywordCount > remaining;
  const canSubmit =
    !!activeSub &&
    remaining > 0 &&
    keywordCount >= 1 &&
    !overCap &&
    !overQuota &&
    !submitting;

  // Telemetry derivations.
  const pillars = useMemo(
    () =>
      computePillars({
        recent: recentMetrics,
        prior: priorMetrics,
        quotaUsed: activeSub?.articles_used_this_period ?? 0,
        quotaTotal: activeSub?.articles_quota ?? 0,
      }),
    [recentMetrics, priorMetrics, activeSub],
  );

  const tasks = useMemo(
    () =>
      computeTasks({
        articles: recentMetrics,
        jobs,
        sites,
        voices,
        quotaUsed: activeSub?.articles_used_this_period ?? 0,
        quotaTotal: activeSub?.articles_quota ?? 0,
      }),
    [recentMetrics, jobs, sites, voices, activeSub],
  );

  const healthBreakdown = useMemo(() => {
    const get = (id) => pillars.find((p) => p.id === id)?.value ?? null;
    return { receipts: get('receipts'), aeo: get('aeo'), voice: get('voice') };
  }, [pillars]);

  const health = useMemo(() => {
    const parts = [healthBreakdown.receipts, healthBreakdown.aeo, healthBreakdown.voice].filter(
      (v) => v != null,
    );
    if (parts.length === 0) return null;
    return Math.round(parts.reduce((s, v) => s + v, 0) / parts.length);
  }, [healthBreakdown]);

  // Strip metadata. voiceHost is the bare domain (used by the
  // visibility chart's "your domain" copy); voiceLabel is the
  // human-readable form for the status tile.
  const voiceHost = useMemo(() => {
    if (!voices?.[0]?.source_url) return null;
    try {
      return new URL(voices[0].source_url).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }, [voices]);
  const voiceLabel = useMemo(() => formatVoiceLabel(voices, sites), [voices, sites]);
  const siteName = sites?.[0]?.name ?? null;
  // "Next run" considers both immediate jobs and the next scheduled
  // drip release. A running job → 0 (happening now). A queued job with
  // no release_at → 0 (claimable now). A scheduled job → hours until
  // release_at fires. Picks the earliest of those.
  const nextRunHours = useMemo(() => {
    const running = jobs.find((j) => j.status === 'running');
    if (running) return 0;
    const readyQueued = jobs.find(
      (j) => j.status === 'queued' && (!j.release_at || new Date(j.release_at) <= new Date()),
    );
    if (readyQueued) return 0;
    const scheduled = jobs
      .filter((j) => j.status === 'queued' && j.release_at)
      .map((j) => new Date(j.release_at).getTime())
      .sort((a, b) => a - b)[0];
    if (!scheduled) return null;
    return Math.max(0, Math.round((scheduled - Date.now()) / (1000 * 60 * 60)));
  }, [jobs]);
  const jobsQueued = useMemo(
    () => jobs.filter((j) => j.status === 'queued' || j.status === 'running').length,
    [jobs],
  );
  const org = useMemo(() => pickOrgName({ user, voices, sites }), [user, voices, sites]);

  // Feed: merge jobs+articles into a single chronological wire.
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
    for (const a of articles) {
      if (!seenArticleIds.has(a.id)) {
        out.push({ kind: 'article', article: a, ts: a.generated_at });
      }
    }
    out.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    return out;
  }, [jobs, articles, articleById]);

  // Submit handler — writes one job row per keyword. When the drip
  // toggle is on and the batch has 2+ keywords, each row gets a
  // future release_at timestamp so the worker only claims them as
  // their slot comes due. The first row releases immediately so the
  // user sees something start moving; the Nth row releases at +30
  // days. Linear spacing between, computed as 30days/(N-1).
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);

    const shouldDrip = dripOverMonth && parsedKeywords.length >= 2;
    const dripBatchId = shouldDrip ? crypto.randomUUID() : null;
    const totalMs = DRIP_DAYS * 24 * 60 * 60 * 1000;
    const intervalMs = shouldDrip ? totalMs / (parsedKeywords.length - 1) : 0;
    const now = Date.now();

    const rows = parsedKeywords.map((kw, i) => ({
      user_id: user.id,
      keyword: kw,
      voice_id: voiceId || null,
      auto_publish_site_id: autoPublishSiteId || null,
      auto_publish_live: autoPublishSiteId ? autoPublishLive : false,
      release_at: shouldDrip ? new Date(now + i * intervalMs).toISOString() : null,
      drip_batch_id: dripBatchId,
      drip_position: shouldDrip ? i + 1 : null,
    }));

    const { data: inserted, error } = await supabase.from('jobs').insert(rows).select('id');
    setSubmitting(false);

    if (error) {
      const msg = error.message || 'Could not enqueue jobs.';
      if (msg.includes('quota_exceeded')) {
        toast('Quota exhausted for this period. Upgrade or wait for renewal.', { tone: 'danger' });
      } else if (msg.includes('no_active_subscription')) {
        toast('Subscribe to a plan before generating articles.', { tone: 'danger' });
      } else {
        toast(msg, { tone: 'danger' });
      }
      return;
    }
    const queuedCount = inserted?.length ?? rows.length;
    setKeyword('');
    if (shouldDrip) {
      const lastReleaseDate = new Date(now + (queuedCount - 1) * intervalMs);
      toast(
        `${queuedCount} jobs scheduled — first publishes now, last on ${lastReleaseDate.toLocaleDateString(
          'en-US',
          { month: 'short', day: 'numeric' },
        )}.`,
        { tone: 'success' },
      );
    } else {
      toast(
        queuedCount === 1
          ? 'Job queued. The worker will pick it up shortly.'
          : `${queuedCount} jobs queued. They'll run one at a time.`,
        { tone: 'success' },
      );
    }
    load();
  };

  const hasArticles = (articles?.length ?? 0) > 0;

  return (
    <div className="editorial-shell">
      <div style={{ maxWidth: 1480, margin: '0 auto', position: 'relative', zIndex: 1 }}>
        <Masthead activeSub={activeSub} org={org} />

        <TrialBanner activeSub={activeSub} />

        <StatusStrip
          recentArticleCount={recentMetrics.length}
          voiceHost={voiceHost}
          voiceLabel={voiceLabel}
          siteName={siteName}
          nextRunHours={nextRunHours}
          jobsQueued={jobsQueued}
          quotaUsed={activeSub?.articles_used_this_period ?? 0}
          quotaTotal={activeSub?.articles_quota ?? 0}
        />

        <section
          className="ed-telemetry"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(320px, 380px) 1.4fr minmax(300px, 360px)',
            borderBottom: '1px solid var(--rule)',
          }}
        >
          <HealthGauge
            value={health}
            breakdown={healthBreakdown}
            note={healthNote(health, healthBreakdown)}
          />
          <QualityPillars pillars={pillars} />
          <TasksList tasks={tasks} />
        </section>

        {user?.id && user?.created_at && (
          <VisibilityChartEditorial
            userId={user.id}
            signupDate={user.created_at}
            voiceHost={voiceHost}
            snapshots={visibilitySnapshots}
          />
        )}

        <Onboarding
          sites={sites}
          voices={voices}
          hasArticles={hasArticles}
          userId={user?.id}
        />

        {activeSub ? (
          <div id="keyword-form" style={{ scrollMarginTop: 80 }}>
          <KeywordForm
            keyword={keyword}
            setKeyword={setKeyword}
            voiceId={voiceId}
            setVoiceId={setVoiceId}
            autoPublishSiteId={autoPublishSiteId}
            setAutoPublishSiteId={setAutoPublishSiteId}
            autoPublishLive={autoPublishLive}
            setAutoPublishLive={setAutoPublishLive}
            dripOverMonth={dripOverMonth}
            setDripOverMonth={setDripOverMonth}
            dripDays={DRIP_DAYS}
            voices={voices}
            voiceStrengths={voiceStrengths}
            sites={sites}
            submitting={submitting}
            canSubmit={canSubmit}
            remaining={remaining}
            keywordCount={keywordCount}
            overCap={overCap}
            overQuota={overQuota}
            maxBulk={MAX_BULK}
            onSubmit={handleSubmit}
          />
          </div>
        ) : (
          <NoPlanBanner />
        )}

        <div id="recent">
          <RecentFeed
            rows={rows}
            sites={sites}
            userId={user?.id}
            onChanged={load}
            toast={toast}
            canLoadMore={articles.length >= articleLimit}
            onLoadMore={() => setArticleLimit((n) => n + 20)}
          />
        </div>

        <Colophon org={org} />
      </div>
    </div>
  );
}

// When the user has no active subscription, the keyword form is
// replaced by this CTA. Same styling tokens as the surrounding
// editorial chrome so it doesn't look like a fallback.
function NoPlanBanner() {
  return (
    <section
      style={{
        padding: '40px 32px',
        borderTop: '1px solid var(--rule)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 24,
      }}
    >
      <div>
        <span className="ed-eyebrow">No active plan</span>
        <h2
          className="ed-serif"
          style={{
            margin: '8px 0 0',
            fontSize: 30,
            fontStyle: 'italic',
            color: 'var(--paper)',
          }}
        >
          Subscribe a plan to start filing.
        </h2>
      </div>
      <a
        href="/app/pricing"
        style={{
          padding: '12px 18px',
          background: 'oklch(83% 0.21 130)',
          color: 'var(--ink-0)',
          fontFamily: 'var(--ed-mono)',
          fontSize: 11,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          borderRadius: 3,
          fontWeight: 600,
        }}
      >
        See plans →
      </a>
    </section>
  );
}
