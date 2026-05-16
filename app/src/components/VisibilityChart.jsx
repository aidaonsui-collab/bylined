// AI-visibility chart (v1 — uses client-side mock data).
//
// Shows a weekly trend line of total AI-engine citations across
// Perplexity / ChatGPT / Claude, plus a "this week" breakdown.
// The big "PREVIEW" badge + "first real check runs Sunday" copy is
// there on purpose — without it, a customer would mistake the
// chart for a real measurement they don't yet have.
//
// Inline SVG only — no chart library. Single line + dots is plenty
// for a card-sized sparkline; if we ever want stacked area per engine
// or hover tooltips, that's the right time to reach for recharts.

import { useMemo } from 'react';
import { mockVisibilityHistory, VISIBILITY_MAX_PER_WEEK } from '../lib/mockVisibility.js';

const W = 560;
const H = 140;
const PAD_L = 36;
const PAD_R = 16;
const PAD_T = 12;
const PAD_B = 28;

export default function VisibilityChart({ userId, signupDate }) {
  const history = useMemo(
    () => mockVisibilityHistory(userId, signupDate),
    [userId, signupDate],
  );

  if (history.length === 0) {
    return (
      <div className="app-callout" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <ChartHeader />
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '12px 0 0' }}>
          Your first AI-visibility snapshot will run after the cron pipeline
          lands. Once it does, this card shows weekly trend lines for
          Perplexity, ChatGPT, and Claude citations.
        </p>
      </div>
    );
  }

  const current = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const delta = previous ? current.total - previous.total : 0;

  // Scale: max in series, with a small headroom + floor so a flat-zero
  // series still has a y-axis.
  const yMax = Math.max(4, ...history.map((h) => h.total)) * 1.15;
  const xCount = Math.max(history.length - 1, 1);
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const xAt = (i) => PAD_L + (i / xCount) * innerW;
  const yAt = (v) => PAD_T + innerH - (v / yMax) * innerH;

  const linePath = history
    .map((h, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(h.total).toFixed(1)}`)
    .join(' ');

  // Area fill under the line so the trend reads at a glance.
  const areaPath =
    `M ${xAt(0).toFixed(1)} ${(PAD_T + innerH).toFixed(1)} ` +
    history
      .map((h, i) => `L ${xAt(i).toFixed(1)} ${yAt(h.total).toFixed(1)}`)
      .join(' ') +
    ` L ${xAt(history.length - 1).toFixed(1)} ${(PAD_T + innerH).toFixed(1)} Z`;

  // Y-axis ticks at 0, mid, max.
  const yTicks = [0, Math.round(yMax / 2), Math.round(yMax)];

  return (
    <div className="app-callout" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 14 }}>
      <ChartHeader />

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Chart */}
        <div style={{ flex: '1 1 360px', minWidth: 0 }}>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', overflow: 'visible' }}>
            {/* Y-axis labels + grid lines */}
            {yTicks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={yAt(t)}
                  y2={yAt(t)}
                  stroke="var(--border)"
                  strokeWidth="1"
                  strokeDasharray={t === 0 ? '' : '2 4'}
                />
                <text
                  x={PAD_L - 6}
                  y={yAt(t) + 4}
                  textAnchor="end"
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                  fill="var(--fg-subtle)"
                >
                  {t}
                </text>
              </g>
            ))}

            {/* Area + line */}
            <path d={areaPath} fill="var(--accent-faint)" />
            <path
              d={linePath}
              fill="none"
              stroke="var(--accent-text)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* Dots at each week */}
            {history.map((h, i) => (
              <circle
                key={i}
                cx={xAt(i)}
                cy={yAt(h.total)}
                r={i === history.length - 1 ? 4 : 2.5}
                fill="var(--accent)"
                stroke="var(--bg)"
                strokeWidth="1"
              />
            ))}

            {/* X-axis labels: week numbers */}
            {history.map((h, i) => (
              <text
                key={i}
                x={xAt(i)}
                y={H - 8}
                textAnchor="middle"
                fontSize="10"
                fontFamily="var(--font-mono)"
                fill="var(--fg-subtle)"
              >
                W{h.week + 1}
              </text>
            ))}
          </svg>
        </div>

        {/* This-week panel */}
        <div style={{ flex: '0 0 180px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: 0.04 }}>
            Week {current.week + 1}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span className="mono" style={{ fontSize: 26, fontWeight: 600, color: 'var(--fg)' }}>
              {current.total}
            </span>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              of {VISIBILITY_MAX_PER_WEEK} possible
            </span>
          </div>
          {previous && (
            <div style={{ fontSize: 11, color: delta >= 0 ? 'var(--accent-text)' : 'var(--danger)' }}>
              {delta >= 0 ? '↑' : '↓'} {Math.abs(delta)} vs week {previous.week + 1}
            </div>
          )}
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <Row label="Perplexity" v={current.perplexity} max={current.questions} />
            <Row label="ChatGPT" v={current.chatgpt} max={current.questions} />
            <Row label="Claude" v={current.claude} max={current.questions} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ChartHeader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="eyebrow">AI visibility — weekly</div>
          <span
            className="chip chip-warn"
            style={{ fontSize: 10, height: 18, padding: '0 6px', letterSpacing: 0.04 }}
            title="Preview chart — uses mocked data until the real cron pipeline ships next session."
          >
            PREVIEW
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
          How often Perplexity, ChatGPT, and Claude cite your domain when asked your customers' buyer questions. Real pipeline ships next session.
        </div>
      </div>
    </div>
  );
}

function Row({ label, v, max }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ color: 'var(--fg-muted)' }}>{label}</span>
      <span className="mono" style={{ color: 'var(--fg)' }}>
        {v}<span style={{ color: 'var(--fg-subtle)' }}>/{max}</span>
      </span>
    </div>
  );
}
