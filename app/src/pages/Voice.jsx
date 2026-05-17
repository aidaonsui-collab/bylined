// Voice — manage brand voice fingerprints.
//
// A "voice" is a structured style profile extracted from a brand's
// existing pages. It gets injected into the article generator's system
// prompt at job time so generated articles match the brand's tone,
// signature phrases, taboo words, and reading level.
//
// Extraction is one-shot (~30–60s). The page calls the
// extract-voice-fingerprint edge function, surfaces a spinner, and
// inserts the row on success. Existing voices are listed below the
// form, expandable to inspect the full fingerprint JSON.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import AppNav from '../components/AppNav.jsx';
import { useToast } from '../components/Toast.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';
import { extractVoiceFingerprint } from '../lib/sites.js';
import { fetchVoiceSuggestions, voiceStrength } from '../lib/suggestVoices.js';

const Plus = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const ChevronDown = ({ size = 14, open }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

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

export default function Voice() {
  const { user, signOut } = useAuth();
  const toast = useToast();
  const [voices, setVoices] = useState([]);
  const [strengthsById, setStrengthsById] = useState({});
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [prefilledUrl, setPrefilledUrl] = useState('');
  const [openId, setOpenId] = useState(null);
  // Suggested voices panel state.
  const [suggestions, setSuggestions] = useState(null);
  const [suggestionsError, setSuggestionsError] = useState(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestContext, setSuggestContext] = useState('');

  const load = async () => {
    if (!isSupabaseConfigured || !user) {
      setLoading(false);
      return;
    }
    // Pull voices + the per-voice strength aggregate in parallel.
    // Strengths come from a SECURITY INVOKER view that joins
    // jobs+articles, so RLS scopes the result by user automatically.
    const [{ data: voiceRows }, { data: strengthRows }] = await Promise.all([
      supabase
        .from('voices')
        .select('id, source_url, fingerprint, created_at, updated_at')
        .order('created_at', { ascending: false }),
      supabase
        .from('voice_strengths')
        .select('voice_id, articles_scored, avg_voice_match, last_used_at'),
    ]);
    setVoices(voiceRows ?? []);
    const byId = {};
    for (const s of strengthRows ?? []) byId[s.voice_id] = s;
    setStrengthsById(byId);
    setLoading(false);
  };

  const loadSuggestions = async () => {
    setLoadingSuggestions(true);
    setSuggestionsError(null);
    const result = await fetchVoiceSuggestions({
      context: suggestContext,
      count: 12,
    });
    setLoadingSuggestions(false);
    if (!result.ok) {
      setSuggestionsError(result.error || 'Failed to fetch suggestions.');
      return;
    }
    setSuggestions(result.suggestions || []);
  };

  const handleExtractSuggestion = (url) => {
    setPrefilledUrl(url);
    setShowForm(true);
    // Smooth scroll to the form so the user sees what's happening.
    setTimeout(() => {
      const el = document.getElementById('voice-extract-form');
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  };

  useEffect(() => {
    load();
  }, [user]);

  const handleDelete = async (voice) => {
    if (
      !confirm(
        `Delete voice for "${voice.source_url}"? Articles already generated with it keep their text; new ones will fall back to a generic voice unless re-attached.`
      )
    )
      return;
    const { error } = await supabase.from('voices').delete().eq('id', voice.id);
    if (error) toast(error.message, { tone: 'danger' });
    else {
      toast('Voice deleted.', { tone: 'success' });
      load();
    }
  };

  return (
    <div className="app-shell">
      <AppNav />

      <main className="app-main">
        <div className="app-container" style={{ maxWidth: 760 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 24,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ minWidth: 0, flex: '1 1 320px' }}>
              <div className="eyebrow" style={{ marginBottom: 14 }}>Voice</div>
              <h1 className="app-h1 serif" style={{ fontSize: 44 }}>Brand voice</h1>
              <p className="app-lede">
                Drop a homepage URL. Bylined ingests several existing pages and
                extracts a style fingerprint — tone, signature phrases, taboo
                words, reading level. Attach a voice to a generation job and the
                article comes out in that voice.
              </p>
            </div>
            <StrengthLegend />
          </div>

          {!showForm && (
            <div style={{ display: 'flex', gap: 10, marginTop: 24, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setPrefilledUrl('');
                  setShowForm(true);
                }}
              >
                <Plus /> Extract a new voice
              </button>
              <button
                type="button"
                className="btn"
                onClick={loadSuggestions}
                disabled={loadingSuggestions}
                title="Brainstorm brand voices to extract from"
              >
                {loadingSuggestions
                  ? 'Brainstorming…'
                  : suggestions
                  ? 'Refresh ideas ↻'
                  : 'Suggest voices ✦'}
              </button>
            </div>
          )}

          {showForm && (
            <div id="voice-extract-form">
              <ExtractForm
                initialUrl={prefilledUrl}
                onCancel={() => {
                  setShowForm(false);
                  setPrefilledUrl('');
                }}
                onCreated={() => {
                  setShowForm(false);
                  setPrefilledUrl('');
                  load();
                }}
                toast={toast}
              />
            </div>
          )}

          {suggestionsError && (
            <div
              role="alert"
              style={{
                marginTop: 16,
                background: 'rgba(245,200,66,0.10)',
                border: '1px solid rgba(245,200,66,0.20)',
                color: 'var(--warn)',
                padding: '10px 12px',
                borderRadius: 8,
                fontSize: 13.5,
              }}
            >
              {suggestionsError}
            </div>
          )}

          {suggestions && (
            <div className="app-callout" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 14, marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div className="eyebrow">Suggested voices</div>
                  <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '4px 0 0' }}>
                    Click a card to pre-fill the extraction form. Each takes 30–60s to extract.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setSuggestions(null)}
                >
                  Dismiss
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {suggestions.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                    No fresh ideas this round — try refining the goal hint and refreshing.
                  </div>
                ) : (
                  suggestions.map((s, i) => (
                    <div
                      key={`${s.url}-${i}`}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr auto',
                        gap: 12,
                        padding: '10px 12px',
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <strong style={{ color: 'var(--fg)' }}>{s.brand_name}</strong>
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mono"
                            style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}
                          >
                            {s.url} ↗
                          </a>
                        </div>
                        {s.style_descriptor && (
                          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 2 }}>
                            {s.style_descriptor}
                          </div>
                        )}
                        {s.why_fit && (
                          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4, fontStyle: 'italic' }}>
                            {s.why_fit}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => handleExtractSuggestion(s.url)}
                        style={{ alignSelf: 'flex-start' }}
                      >
                        Extract
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderTop: '1px dashed var(--border)', paddingTop: 12 }}>
                <input
                  className="input"
                  type="text"
                  value={suggestContext}
                  onChange={(e) => setSuggestContext(e.target.value)}
                  placeholder="Optional: refine the goal (e.g. 'b2b saas thought leadership')"
                  style={{ flex: 1, height: 32, fontSize: 13 }}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={loadSuggestions}
                  disabled={loadingSuggestions}
                >
                  {loadingSuggestions ? '…' : 'Re-brainstorm'}
                </button>
              </div>
            </div>
          )}

          <div style={{ marginTop: 40 }}>
            <div className="eyebrow" style={{ marginBottom: 12 }}>Your voices</div>
            {loading ? (
              <div className="app-callout"><div>Loading…</div></div>
            ) : voices.length === 0 ? (
              <div className="app-callout">
                <div style={{ color: 'var(--fg-muted)' }}>
                  No voices yet. Extract one above to attach it to future
                  article jobs.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {voices.map((v) => (
                  <VoiceRow
                    key={v.id}
                    voice={v}
                    strength={strengthsById[v.id]}
                    isOpen={openId === v.id}
                    onToggle={() => setOpenId(openId === v.id ? null : v.id)}
                    onDelete={() => handleDelete(v)}
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

function ExtractForm({ initialUrl = '', onCancel, onCreated, toast }) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Keep the input in sync when a suggestion pre-fills the URL.
  useEffect(() => {
    if (initialUrl) setUrl(initialUrl);
  }, [initialUrl]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    const result = await extractVoiceFingerprint({ source_url: url.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'Extraction failed.');
      return;
    }
    toast('Voice extracted.', { tone: 'success' });
    onCreated();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="app-callout"
      style={{ flexDirection: 'column', alignItems: 'stretch', gap: 16, marginTop: 24 }}
    >
      <div>
        <div className="eyebrow" style={{ marginBottom: 8 }}>Extract from a homepage</div>
      </div>

      <label className="field">
        <span className="field-label">Homepage URL</span>
        <input
          className="input"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://yourbrand.com"
          disabled={busy}
          autoComplete="off"
          required
        />
        <span style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
          Bylined fetches the homepage and up to 8 internal blog/article
          pages it can find.
        </span>
      </label>

      {error && (
        <div
          role="alert"
          style={{
            background: 'rgba(245,200,66,0.10)',
            border: '1px solid rgba(245,200,66,0.20)',
            color: 'var(--warn)',
            padding: '10px 12px',
            borderRadius: 7,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {busy && (
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Crawling, sampling, and analysing — usually 30–60s.
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>
          {busy ? 'Extracting…' : 'Extract voice'}
        </button>
      </div>
    </form>
  );
}

function VoiceRow({ voice, strength, isOpen, onToggle, onDelete }) {
  const fp = voice.fingerprint ?? {};
  const traits = fp.voice_traits ?? [];
  const phrases = fp.signature_phrases ?? [];
  const taboo = fp.taboo ?? [];
  const pages = fp.pages_analyzed ?? [];
  const badge = voiceStrength({
    avgVoiceMatch: strength?.avg_voice_match,
    pages: pages.length,
    articlesScored: strength?.articles_scored ?? 0,
  });

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
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--fg)' }}>
              {voice.source_url}
            </span>
            <StrengthBadge badge={badge} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
            {pages.length} page{pages.length === 1 ? '' : 's'} analysed ·{' '}
            {relTime(voice.created_at)}
            {fp.technical_level ? ` · ${fp.technical_level}` : ''}
            {strength?.articles_scored > 0 && (
              <>
                {' · '}
                <span className="mono">
                  {strength.articles_scored} article{strength.articles_scored === 1 ? '' : 's'} scored, avg{' '}
                  {strength.avg_voice_match}
                </span>
              </>
            )}
          </div>
        </div>
        <ChevronDown size={14} open={isOpen} />
      </button>

      {isOpen && (
        <div style={{ marginTop: 16, fontSize: 13.5, lineHeight: 1.55 }}>
          {fp.tone && (
            <Section label="Tone">
              <span style={{ color: 'var(--fg)' }}>{fp.tone}</span>
            </Section>
          )}
          {traits.length > 0 && (
            <Section label="Voice traits">
              <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--fg-muted)' }}>
                {traits.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </Section>
          )}
          {phrases.length > 0 && (
            <Section label="Signature phrases">
              <ChipRow items={phrases} />
            </Section>
          )}
          {taboo.length > 0 && (
            <Section label="Taboo">
              <ChipRow items={taboo} warn />
            </Section>
          )}
          {fp.example_paragraph && (
            <Section label="Sample">
              <p
                style={{
                  margin: 0,
                  padding: '10px 12px',
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: 6,
                  color: 'var(--fg)',
                  fontStyle: 'italic',
                }}
              >
                {fp.example_paragraph}
              </p>
            </Section>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onDelete}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="eyebrow" style={{ marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function ChipRow({ items, warn }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map((item, i) => (
        <span key={i} className={`chip ${warn ? 'chip-warn' : 'chip-faint'}`}>
          {item}
        </span>
      ))}
    </div>
  );
}

// Small reference card explaining what the strength badges mean.
// Lives in the top-right of the Voice page so users can decode the
// chips on each voice row without guessing.
function StrengthLegend() {
  const tiers = [
    { label: 'Strong', range: '75+', tone: 'good' },
    { label: 'Solid', range: '60–74', tone: 'good' },
    { label: 'Weak', range: '40–59', tone: 'warn' },
    { label: 'Off-voice', range: '<40', tone: 'bad' },
    { label: 'New', range: 'no data', tone: 'neutral' },
  ];
  return (
    <aside
      style={{
        flex: '0 0 auto',
        minWidth: 200,
        padding: '12px 14px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-card)',
      }}
      aria-label="Voice strength tiers"
    >
      <div
        className="eyebrow"
        style={{ fontSize: 10, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>Strength tiers</span>
        <span className="mono" style={{ fontSize: 9, color: 'var(--fg-faint)', textTransform: 'none', letterSpacing: 0 }}>
          / 100
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {tiers.map((t) => (
          <div
            key={t.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <StrengthBadge badge={{ label: t.label, score: null, tone: t.tone }} />
            <span
              className="mono"
              style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}
            >
              {t.range}
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--fg-subtle)',
          lineHeight: 1.4,
          marginTop: 10,
          paddingTop: 8,
          borderTop: '1px dashed var(--border)',
        }}
      >
        Score = average <span className="mono">voice_match</span> across articles using this voice.
      </div>
    </aside>
  );
}

// Small inline tag rendering the voice-quality grade. Color tone
// follows the strength bucket — "good" maps to the accent, "warn" to
// amber, "bad" to red. Numeric score shows on the right when present.
function StrengthBadge({ badge }) {
  if (!badge) return null;
  const colorByTone = {
    good: { bg: 'var(--accent-faint)', fg: 'var(--accent-text)', border: 'var(--accent-faint)' },
    warn: { bg: 'rgba(245,200,66,0.10)', fg: 'var(--warn)', border: 'rgba(245,200,66,0.30)' },
    bad: { bg: 'rgba(255,99,99,0.10)', fg: 'var(--danger)', border: 'rgba(255,99,99,0.30)' },
    neutral: { bg: 'var(--surface-2)', fg: 'var(--fg-muted)', border: 'var(--border)' },
  };
  const c = colorByTone[badge.tone] || colorByTone.neutral;
  return (
    <span
      title={
        badge.score != null
          ? `Average voice_match_score across articles using this voice: ${badge.score}/100`
          : 'No articles scored against this voice yet'
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 20,
        padding: '0 8px',
        borderRadius: 999,
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.fg,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 0.02,
      }}
    >
      <span>{badge.label}</span>
      {badge.score != null && (
        <span className="mono" style={{ fontSize: 10.5, opacity: 0.85 }}>
          {badge.score}
        </span>
      )}
    </span>
  );
}
