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
import { useToast } from '../components/Toast.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';
import { extractVoiceFingerprint } from '../lib/sites.js';

const Logo = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4 L8 12 L14 20" />
    <circle cx="14" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="14" cy="20" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

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
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = async () => {
    if (!isSupabaseConfigured || !user) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('voices')
      .select('id, source_url, fingerprint, created_at, updated_at')
      .order('created_at', { ascending: false });
    setVoices(data ?? []);
    setLoading(false);
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
        <div className="app-container" style={{ maxWidth: 760 }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}>Voice</div>
          <h1 className="app-h1 serif" style={{ fontSize: 44 }}>Brand voice</h1>
          <p className="app-lede">
            Drop a homepage URL. Bylined ingests several existing pages and
            extracts a style fingerprint — tone, signature phrases, taboo
            words, reading level. Attach a voice to a generation job and the
            article comes out in that voice.
          </p>

          {!showForm && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 24 }}
              onClick={() => setShowForm(true)}
            >
              <Plus /> Extract a new voice
            </button>
          )}

          {showForm && (
            <ExtractForm
              onCancel={() => setShowForm(false)}
              onCreated={() => {
                setShowForm(false);
                load();
              }}
              toast={toast}
            />
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

function ExtractForm({ onCancel, onCreated, toast }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

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

function VoiceRow({ voice, isOpen, onToggle, onDelete }) {
  const fp = voice.fingerprint ?? {};
  const traits = fp.voice_traits ?? [];
  const phrases = fp.signature_phrases ?? [];
  const taboo = fp.taboo ?? [];
  const pages = fp.pages_analyzed ?? [];

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
          <div style={{ fontWeight: 600, color: 'var(--fg)' }}>
            {voice.source_url}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
            {pages.length} page{pages.length === 1 ? '' : 's'} analysed ·{' '}
            {relTime(voice.created_at)}
            {fp.technical_level ? ` · ${fp.technical_level}` : ''}
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
