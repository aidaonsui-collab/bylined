// Article detail — /app/articles/:id
//
// The dedicated deep-review surface for one article: full body, the
// receipt ledger (verified + failed), title/meta editing, publish
// controls, copy-markdown, and regenerate.
//
// Editing scope is deliberately title + meta only. The body is the
// verified artifact — its [^N] markers are bound to receipts that
// passed the validation gate. Letting users edit the body freely would
// let unsourced claims slip in under the "every claim sourced" promise.
// They can copy the markdown out and edit on the CMS side if they want.

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';
import PublishControls from '../components/PublishControls.jsx';
import { regenerateArticle } from '../lib/jobs.js';

const Logo = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4 L8 12 L14 20" />
    <circle cx="14" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="14" cy="20" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

function StatusChip({ status }) {
  const map = {
    draft: { label: 'Draft', cls: 'chip' },
    published: { label: 'Published', cls: 'chip chip-accent' },
    scheduled: { label: 'Scheduled', cls: 'chip chip-faint' },
    failed: { label: 'Failed', cls: 'chip chip-warn' },
  };
  const m = map[status] ?? { label: status, cls: 'chip' };
  return <span className={m.cls}>{m.label}</span>;
}

export default function ArticleDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const toast = useToast();

  const [article, setArticle] = useState(null);
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Editable fields — seeded from the article once it loads.
  const [title, setTitle] = useState('');
  const [meta, setMeta] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !user) {
      setLoading(false);
      return;
    }
    const [aRes, sitesRes] = await Promise.all([
      supabase
        .from('articles')
        .select(
          'id, site_id, keyword, title, meta_description, body_markdown, ' +
            'receipts, pass_rate, status, cms_post_id, cms_post_url, ' +
            'generated_at, published_at'
        )
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('sites')
        .select('id, name, cms_type, is_active')
        .eq('is_active', true)
        .order('name'),
    ]);
    if (!aRes.data) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setArticle(aRes.data);
    setSites(sitesRes.data ?? []);
    setTitle(aRes.data.title ?? '');
    setMeta(aRes.data.meta_description ?? '');
    setLoading(false);
  }, [id, user]);

  useEffect(() => {
    load();
  }, [load]);

  const metaDirty =
    article &&
    (title.trim() !== (article.title ?? '').trim() ||
      meta.trim() !== (article.meta_description ?? '').trim());

  const handleSaveMeta = async () => {
    if (!metaDirty) return;
    if (title.trim().length < 3) {
      toast('Title needs at least 3 characters.', { tone: 'warn' });
      return;
    }
    setSavingMeta(true);
    const { error } = await supabase
      .from('articles')
      .update({ title: title.trim(), meta_description: meta.trim() })
      .eq('id', article.id);
    setSavingMeta(false);
    if (error) {
      toast(error.message, { tone: 'danger' });
      return;
    }
    setArticle({ ...article, title: title.trim(), meta_description: meta.trim() });
    toast('Saved.', { tone: 'success' });
  };

  const handleRegenerate = async () => {
    if (
      !confirm(
        'Regenerate this article? This queues a fresh job (same keyword + voice) and counts as one article against your quota. The current article is kept.'
      )
    )
      return;
    const result = await regenerateArticle(article, user.id);
    if (!result.ok) {
      toast(result.error, { tone: 'danger' });
      return;
    }
    toast('Regeneration queued — watch the dashboard.', { tone: 'success' });
    navigate('/app');
  };

  const receipts = article?.receipts ?? [];
  const verified = receipts.filter((r) => r.verified);
  const failed = receipts.filter((r) => !r.verified);

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
            <Link to="/app/settings" className="app-nav-email">{user?.email}</Link>
            <button type="button" className="btn btn-sm btn-ghost" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <div className="app-container" style={{ maxWidth: 760 }}>
          <Link to="/app" style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            ← Back to articles
          </Link>

          {loading ? (
            <div className="app-callout" style={{ marginTop: 16 }}>
              <div>Loading…</div>
            </div>
          ) : notFound ? (
            <div className="app-callout" style={{ marginTop: 16 }}>
              <div style={{ color: 'var(--fg-muted)' }}>
                Article not found, or you don't have access to it.
              </div>
            </div>
          ) : (
            <>
              {/* ─── Header / meta ─────────────────────────── */}
              <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <StatusChip status={article.status} />
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  {verified.length}/{receipts.length} cites ·{' '}
                  {((article.pass_rate ?? 0) * 100).toFixed(0)}% pass rate
                </span>
              </div>

              <div
                className="app-callout"
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: 14, marginTop: 16 }}
              >
                <label className="field">
                  <span className="field-label">Title</span>
                  <input
                    className="input"
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Meta description</span>
                  <textarea
                    className="input"
                    value={meta}
                    onChange={(e) => setMeta(e.target.value)}
                    rows={2}
                    maxLength={320}
                    style={{ resize: 'vertical', minHeight: 52, paddingTop: 8 }}
                  />
                </label>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                    Keyword: <span className="mono">{article.keyword}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={handleSaveMeta}
                    disabled={!metaDirty || savingMeta}
                  >
                    {savingMeta ? 'Saving…' : 'Save title & meta'}
                  </button>
                </div>
              </div>

              {/* ─── Publish + actions ─────────────────────── */}
              <div
                className="app-callout"
                style={{ gap: 10, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}
              >
                <PublishControls
                  article={article}
                  sites={sites}
                  onPublished={load}
                  toast={toast}
                />
                {article.status === 'published' && article.cms_post_url && (
                  <a
                    href={article.cms_post_url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm"
                  >
                    View on site →
                  </a>
                )}
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    navigator.clipboard.writeText(article.body_markdown);
                    toast('Markdown copied', { tone: 'success' });
                  }}
                >
                  Copy markdown
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={handleRegenerate}
                >
                  Regenerate
                </button>
              </div>

              {/* ─── Body ──────────────────────────────────── */}
              <div style={{ marginTop: 32 }}>
                <div className="eyebrow" style={{ marginBottom: 10 }}>Body</div>
                <pre
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    padding: 16,
                    borderRadius: 8,
                    whiteSpace: 'pre-wrap',
                    fontSize: 13.5,
                    lineHeight: 1.6,
                    color: 'var(--fg)',
                    overflow: 'auto',
                  }}
                >
                  {article.body_markdown}
                </pre>
                <p style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 8 }}>
                  Body is read-only — it's the verified artifact. Copy the
                  markdown to edit it on your CMS side.
                </p>
              </div>

              {/* ─── Receipts ──────────────────────────────── */}
              <div style={{ marginTop: 32 }}>
                <div className="eyebrow" style={{ marginBottom: 10 }}>
                  Receipts · {verified.length} verified
                  {failed.length > 0 ? ` · ${failed.length} unverified` : ''}
                </div>

                {verified.length > 0 && (
                  <ol style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {verified.map((r) => (
                      <li key={r.id} style={{ fontSize: 13, lineHeight: 1.5 }}>
                        <span style={{ color: 'var(--fg)' }}>
                          &ldquo;{r.passage}&rdquo;
                        </span>
                        <div style={{ marginTop: 2, fontSize: 12 }}>
                          <a href={r.source_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-text)' }}>
                            {r.source_url}
                          </a>
                          {r.wayback_url && (
                            <>
                              {' · '}
                              <a href={r.wayback_url} target="_blank" rel="noreferrer" style={{ color: 'var(--fg-muted)' }}>
                                archived
                              </a>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}

                {failed.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 8 }}>
                      Unverified — generated but didn't pass a validation gate,
                      so they carry no inline marker in the body:
                    </div>
                    <ul style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {failed.map((r, i) => (
                        <li key={`f-${i}`} style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                          &ldquo;{r.passage}&rdquo;
                          {r.verification_notes && (
                            <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                              {r.verification_notes}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
