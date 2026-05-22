// Review — admin-only, cross-account queue of articles awaiting a human audit.
//
// Generated articles land in 'pending_review' (the worker no longer
// auto-publishes). This page lists every pending article across ALL
// accounts via the admin_list_pending_articles RPC — a SECURITY DEFINER
// function gated to profiles.is_admin, so it can see other users' rows.
// The founder reads each one and either approves it (→ 'draft', a normal
// publishable article) or rejects it (→ 'failed').

import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import AppNav from '../components/AppNav.jsx';
import { useToast } from '../components/Toast.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';
import { publishArticle } from '../lib/sites.js';

function relTime(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function Review() {
  const { profile } = useAuth();
  const toast = useToast();
  const [articles, setArticles] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    if (!isSupabaseConfigured) {
      setArticles([]);
      return;
    }
    const { data, error: err } = await supabase.rpc('admin_list_pending_articles');
    if (err) {
      setError(err.message);
      setArticles([]);
      return;
    }
    setError(null);
    setArticles(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    if (profile?.is_admin) load();
  }, [profile?.is_admin]);

  const reject = async (id) => {
    if (!confirm('Reject this article? It will be marked failed.')) return;
    setBusyId(id);
    const { error: err } = await supabase.rpc('admin_set_article_status', {
      p_article_id: id,
      p_status: 'failed',
    });
    setBusyId(null);
    if (err) {
      toast(err.message || 'Action failed.', { tone: 'danger' });
      return;
    }
    toast('Rejected.', { tone: 'success' });
    setArticles((prev) => (prev || []).filter((a) => a.id !== id));
    setOpenId(null);
  };

  // Approving an article with a connected publish destination sends it
  // live straight to the customer's CMS — publish-article runs the
  // admin path so it can act on another account's article. With no site
  // connected, it just becomes a publishable draft in their dashboard.
  const approve = async (article) => {
    setBusyId(article.id);
    if (article.site_id) {
      const res = await publishArticle({
        article_id: article.id,
        site_id: article.site_id,
        live: true,
      });
      setBusyId(null);
      if (!res.ok) {
        toast(res.error || 'Publish failed.', { tone: 'danger' });
        return;
      }
      toast(res.url ? `Published → ${res.url}` : 'Published live.', {
        tone: 'success',
      });
    } else {
      const { error: err } = await supabase.rpc('admin_set_article_status', {
        p_article_id: article.id,
        p_status: 'draft',
      });
      setBusyId(null);
      if (err) {
        toast(err.message || 'Approve failed.', { tone: 'danger' });
        return;
      }
      toast('Approved — no site connected, saved as a draft.', {
        tone: 'success',
      });
    }
    setArticles((prev) => (prev || []).filter((a) => a.id !== article.id));
    setOpenId(null);
  };

  // Profile loaded and not an admin → bounce. While it's still loading,
  // fall through to the shell (shows "Loading…").
  if (profile && !profile.is_admin) return <Navigate to="/app" replace />;

  return (
    <div className="app-shell">
      <AppNav />
      <main className="app-main">
        <div className="app-container" style={{ maxWidth: 820 }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}>Admin</div>
          <h1 className="app-h1 serif" style={{ fontSize: 44 }}>
            Review queue
            {articles?.length ? (
              <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}> · {articles.length}</span>
            ) : null}
          </h1>
          <p className="app-lede">
            Every generated article across all accounts waits here for a human
            audit before it can be published. Read it, then approve it to a
            publishable draft or reject it.
          </p>

          {error && (
            <div className="app-callout" style={{ marginTop: 20 }}>
              <div style={{ color: 'var(--danger)' }}>{error}</div>
            </div>
          )}

          <div style={{ marginTop: 28 }}>
            {articles === null ? (
              <div className="app-callout"><div>Loading…</div></div>
            ) : articles.length === 0 ? (
              <div className="app-callout">
                <div style={{ color: 'var(--fg-muted)' }}>
                  Nothing pending review. Generated articles land here for audit.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {articles.map((a) => (
                  <ReviewCard
                    key={a.id}
                    article={a}
                    isOpen={openId === a.id}
                    busy={busyId === a.id}
                    onToggle={() => setOpenId(openId === a.id ? null : a.id)}
                    onApprove={() => approve(a)}
                    onReject={() => reject(a.id)}
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

function ReviewCard({ article, isOpen, busy, onToggle, onApprove, onReject }) {
  const pass =
    typeof article.pass_rate === 'number'
      ? `${Math.round(article.pass_rate * 100)}% pass`
      : null;

  return (
    <div className="app-tile" style={{ padding: 16 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          background: 'none',
          border: 0,
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          width: '100%',
          color: 'inherit',
        }}
      >
        <div style={{ fontWeight: 600, color: 'var(--fg)' }}>
          {article.title || article.keyword || '(untitled)'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 3 }}>
          {[article.keyword, article.owner_email, relTime(article.generated_at), pass]
            .filter(Boolean)
            .join('  ·  ')}
        </div>
      </button>

      {isOpen && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          {/* Raw markdown — exactly what was generated, citation markers
              and all. Best surface for an audit: read the claims, check
              the receipts, catch garbled phrasing. */}
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.6,
              color: 'var(--fg)',
              whiteSpace: 'pre-wrap',
              maxHeight: 460,
              overflowY: 'auto',
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '12px 14px',
            }}
          >
            {article.body_markdown || '(empty body)'}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onReject} disabled={busy}>
              {busy ? '…' : 'Reject'}
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={onApprove} disabled={busy}>
              {busy ? '…' : article.site_id ? 'Approve & publish' : 'Approve → draft'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
