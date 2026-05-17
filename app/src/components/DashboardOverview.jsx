// In-app dashboard — shows publishing status, quality scores, and
// "tasks for this week" above the keyword form on /app. All numbers
// come from data the parent already loads (articles, jobs, sites,
// voices, activeSub) — no extra fetches.
//
// Scoring inputs:
//   - articles.aeo_score          (0-100, written by engine/src/scorer.ts)
//   - articles.voice_match_score  (0-100, null when no voice was used)
//   - articles.pass_rate          (0-1, first-pass verification rate)
//   - subscriptions.articles_used_this_period / articles_quota
//
// Articles older than 30 days are excluded so the gauges reflect
// what's shipping now, not stale stats.

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import VisibilityChart from './VisibilityChart.jsx';

const WINDOW_DAYS = 30;

export default function DashboardOverview({
  activeSub,
  articles,
  jobs,
  sites,
  voices,
  userId,
  signupDate,
}) {
  const metrics = useMemo(() => {
    const since = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const recent = (articles ?? []).filter((a) => {
      const t = a.generated_at ? new Date(a.generated_at).getTime() : 0;
      return t >= since;
    });

    const receipts = avg(
      recent.map((a) => (typeof a.pass_rate === 'number' ? a.pass_rate * 100 : null)),
    );
    const aeo = avg(recent.map((a) => a.aeo_score));
    const voice = avg(recent.map((a) => a.voice_match_score));

    const quotaUsed = activeSub?.articles_used_this_period ?? 0;
    const quotaTotal = activeSub?.articles_quota ?? 0;
    const velocity = quotaTotal > 0 ? Math.round((quotaUsed / quotaTotal) * 100) : 0;

    const components = [receipts, aeo, voice].filter((v) => v != null);
    const health =
      components.length > 0
        ? Math.round(components.reduce((s, v) => s + v, 0) / components.length)
        : null;

    return {
      health,
      receipts,
      aeo,
      voice,
      velocity,
      quotaUsed,
      quotaTotal,
      recentCount: recent.length,
    };
  }, [activeSub, articles]);

  const tasks = useMemo(() => {
    const draftCount = (articles ?? []).filter((a) => a.status === 'draft').length;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const failedJobs = (jobs ?? []).filter(
      (j) =>
        j.status === 'failed' &&
        new Date(j.created_at).getTime() >= sevenDaysAgo,
    ).length;
    const sitesNoVoice = (sites ?? []).filter(
      (s) => s.is_active && !s.voice_id,
    ).length;
    const lowReceipts = (articles ?? []).filter((a) => {
      const t = a.generated_at ? new Date(a.generated_at).getTime() : 0;
      const since30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
      return t >= since30 && typeof a.pass_rate === 'number' && a.pass_rate < 0.95;
    }).length;
    const quotaPct = metrics.quotaTotal > 0 ? metrics.quotaUsed / metrics.quotaTotal : 0;
    const quotaWarn = quotaPct >= 0.9 && quotaPct < 1 ? 1 : 0;

    return [
      { key: 'drafts', label: 'Drafts awaiting publish', count: draftCount, to: '#recent' },
      { key: 'sites', label: 'Sites missing voice fingerprint', count: sitesNoVoice, to: '/app/sites' },
      { key: 'receipts', label: 'Articles below 95% receipts', count: lowReceipts, to: '#recent' },
      { key: 'failed', label: 'Failed jobs (last 7d)', count: failedJobs, to: '#recent' },
      { key: 'quota', label: 'Quota nearing limit', count: quotaWarn, to: '/app/billing' },
    ];
  }, [articles, jobs, sites, metrics.quotaUsed, metrics.quotaTotal]);

  const openCount = tasks.filter((t) => t.count > 0).length;

  const activeVoiceLabel = formatVoiceLabel(voices, sites);
  const activeSiteName = sites?.[0]?.name ?? sites?.[0]?.domain ?? null;
  const nextRunHrs = nextScheduledHours(jobs);

  return (
    <section className="dash-overview" aria-label="Publishing dashboard">
      {/* Top status strip */}
      <div className="dash-status">
        <StatusItem
          label={metrics.recentCount > 0 ? 'Bylined is publishing' : 'Idle — no recent articles'}
          tone={metrics.recentCount > 0 ? 'on' : 'muted'}
          value={`${metrics.recentCount} in last ${WINDOW_DAYS}d`}
        />
        <StatusItem
          label="Brand voice"
          tone={activeVoiceLabel ? 'on' : 'warn'}
          value={activeVoiceLabel ?? 'Not set'}
        />
        <StatusItem
          label="Connected site"
          tone={activeSiteName ? 'on' : 'warn'}
          value={activeSiteName ?? 'None'}
        />
        <StatusItem
          label="Next run"
          tone="muted"
          value={nextRunHrs != null ? `in ${nextRunHrs}h` : '—'}
        />
        <StatusItem
          label="Quota this period"
          tone={metrics.velocity >= 90 ? 'warn' : 'muted'}
          value={`${metrics.quotaUsed} / ${metrics.quotaTotal || '—'}`}
        />
      </div>

      <div className="dash-grid">
        {/* Publishing Health gauge */}
        <div className="dash-card dash-card-gauge">
          <div className="dash-card-eyebrow">Publishing Health</div>
          <RadialGauge value={metrics.health} />
          <div className="dash-card-sub">
            {metrics.health == null
              ? 'Ship a few articles to get scored.'
              : healthCopy(metrics.health)}
          </div>
        </div>

        {/* Pillars */}
        <div className="dash-card dash-card-pillars">
          <div className="dash-card-eyebrow">Quality pillars · last {WINDOW_DAYS}d</div>
          <div className="dash-pillars">
            <Pillar label="Receipts" value={metrics.receipts} target={95} />
            <Pillar label="AEO" value={metrics.aeo} target={60} />
            <Pillar label="Voice" value={metrics.voice} target={60} />
            <Pillar label="Velocity" value={metrics.velocity} target={null} tone="neutral" />
          </div>
        </div>

        {/* Tasks for this week */}
        <div className="dash-card dash-card-tasks">
          <div className="dash-card-eyebrow">
            <span>Tasks for this week</span>
            <span className="dash-task-tally">
              {openCount}/{tasks.length}
            </span>
          </div>
          <div className="dash-tasks">
            {tasks.map((t) => (
              <TaskRow key={t.key} task={t} />
            ))}
          </div>
        </div>
      </div>

      {/* AI-visibility weekly trend — full-width below the grid because
          it's a time-series view, not a per-window summary. v1 uses
          client-side mock data (see lib/mockVisibility.js); v2 swaps
          to live visibility_snapshots rows. */}
      {userId && signupDate && (
        <div style={{ marginTop: 16 }}>
          <VisibilityChart userId={userId} signupDate={signupDate} />
        </div>
      )}
    </section>
  );
}

// ── Sub-components ─────────────────────────────────────────────────

function StatusItem({ label, value, tone = 'muted' }) {
  return (
    <div className={`dash-status-item dash-status-${tone}`}>
      <div className="dash-status-label">{label}</div>
      <div className="dash-status-value">{value}</div>
    </div>
  );
}

function RadialGauge({ value }) {
  const r = 62;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const offset = c * (1 - pct / 100);
  const tone = toneFor(value);
  return (
    <div className="dash-radial">
      <svg viewBox="0 0 160 160" className="dash-radial-svg" aria-hidden="true">
        <circle cx="80" cy="80" r={r} fill="none" stroke="var(--border)" strokeWidth="10" />
        <circle
          cx="80"
          cy="80"
          r={r}
          fill="none"
          stroke={`var(${tone.var})`}
          strokeWidth="10"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 80 80)"
          style={{ transition: 'stroke-dashoffset 600ms ease' }}
        />
      </svg>
      <div className="dash-radial-value">
        {value == null ? '—' : value}
        <span>/100</span>
      </div>
    </div>
  );
}

function Pillar({ label, value, target, tone = 'auto' }) {
  const display = value == null ? '—' : Math.round(value);
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const t = tone === 'auto' ? toneFor(value, target) : { color: 'var(--fg-muted)' };
  return (
    <div className="dash-pillar">
      <div className="dash-pillar-track">
        <div
          className="dash-pillar-fill"
          style={{
            height: `${pct}%`,
            background: tone === 'auto' ? `var(${t.var})` : 'var(--fg-muted)',
          }}
        />
      </div>
      <div className="dash-pillar-value">{display}</div>
      <div className="dash-pillar-label">{label}</div>
    </div>
  );
}

function TaskRow({ task }) {
  const isAnchor = task.to.startsWith('#');
  const cls = `dash-task ${task.count > 0 ? 'is-open' : 'is-done'}`;
  const inner = (
    <>
      <span className="dash-task-dot" aria-hidden="true" />
      <span className="dash-task-label">{task.label}</span>
      <span className="dash-task-count">{task.count}</span>
    </>
  );
  if (isAnchor) {
    return (
      <a href={task.to} className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <Link to={task.to} className={cls}>
      {inner}
    </Link>
  );
}

// ── helpers ────────────────────────────────────────────────────────

function avg(arr) {
  const nums = arr.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((s, v) => s + v, 0) / nums.length);
}

function toneFor(value, target = 60) {
  if (value == null) return { var: '--fg-faint' };
  const t = target ?? 60;
  if (value >= t) return { var: '--success' };
  if (value >= t * 0.66) return { var: '--accent' };
  if (value >= t * 0.33) return { var: '--warn' };
  return { var: '--danger' };
}

function healthCopy(v) {
  if (v >= 80) return 'Looking healthy. Keep shipping.';
  if (v >= 60) return 'Solid. Small wins in AEO + voice will lift this.';
  if (v >= 40) return 'Receipts and AEO scores need attention.';
  return 'Below target — check recent drafts before they publish.';
}

function nextScheduledHours(jobs) {
  const queued = (jobs ?? []).find((j) => j.status === 'queued' || j.status === 'running');
  if (!queued) return null;
  const ageMs = Date.now() - new Date(queued.created_at).getTime();
  const hrs = Math.max(0, Math.round(24 - ageMs / (1000 * 60 * 60)));
  return hrs;
}

// Known editorial domains that customers commonly point a voice at — we
// show a friendlier label than the bare hostname. Extend as needed.
const KNOWN_VOICE_SOURCES = {
  'stripe.com': 'Stripe blog',
  'animalz.co': 'Animalz blog',
  'lennysnewsletter.com': 'Lenny’s Newsletter',
  'stratechery.com': 'Stratechery',
  'ahrefs.com': 'Ahrefs blog',
  'backlinko.com': 'Backlinko',
  'hubspot.com': 'HubSpot blog',
  'paulgraham.com': 'Paul Graham essays',
};

// Build a "Brand voice" status-tile label. If the voice source matches one
// of the customer's connected sites we treat it as their own brand; if it
// doesn't, we tag it "(example)" so customers don't mistake a borrowed
// style reference for their own.
function formatVoiceLabel(voices, sites) {
  const src = voices?.[0]?.source_url;
  if (!src) return null;
  let host;
  try {
    host = new URL(src).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  const friendly = KNOWN_VOICE_SOURCES[host] ?? `${host} blog`;
  const siteHosts = (sites ?? [])
    .map((s) => {
      if (!s.domain) return null;
      try { return new URL(s.domain.startsWith('http') ? s.domain : `https://${s.domain}`)
        .hostname.replace(/^www\./, ''); }
      catch { return null; }
    })
    .filter(Boolean);
  const isOwnSite = siteHosts.includes(host);
  return isOwnSite ? friendly : `${friendly} (example)`;
}
