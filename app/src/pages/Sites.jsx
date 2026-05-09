// Sites — connect a CMS where Bylined publishes articles.
//
// Today: WordPress only (URL + username + Application Password). Webflow
// + others appear in the picker as "Coming soon" so the IA holds.
//
// The credential leaves the browser exactly twice:
//   1. Verify — POST to verify-wordpress-site edge function
//   2. Save   — INSERT into public.sites (cms_config jsonb)
// We never read the password back into the form for editing — instead,
// "edit" is delete + re-add. Simpler and safer.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';
import { CMS_TYPES, verifyWordPress } from '../lib/sites.js';

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

const Check = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export default function Sites() {
  const { user, signOut } = useAuth();
  const toast = useToast();
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    if (!isSupabaseConfigured || !user) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('sites')
      .select('id, name, domain, cms_type, cms_config, is_active, created_at')
      .order('created_at', { ascending: false });
    setSites(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // No realtime — sites change rarely and the user is the only writer.
  }, [user]);

  const handleDelete = async (site) => {
    if (
      !confirm(
        `Disconnect "${site.name}"? Articles already published won't be unpublished, but Bylined will stop being able to publish to this site.`
      )
    )
      return;
    const { error } = await supabase.from('sites').delete().eq('id', site.id);
    if (error) {
      toast(error.message, { tone: 'danger' });
    } else {
      toast('Site disconnected.', { tone: 'success' });
      load();
    }
  };

  const handleTogglePause = async (site) => {
    const { error } = await supabase
      .from('sites')
      .update({ is_active: !site.is_active })
      .eq('id', site.id);
    if (error) toast(error.message, { tone: 'danger' });
    else load();
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
          <div className="eyebrow" style={{ marginBottom: 14 }}>Sites</div>
          <h1 className="app-h1 serif" style={{ fontSize: 44 }}>Connected sites</h1>
          <p className="app-lede">
            Connect a CMS so Bylined can publish drafted articles directly to it.
            Drafts stay drafts until you click Publish on a finished article.
          </p>

          {!showForm && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 24 }}
              onClick={() => setShowForm(true)}
            >
              <Plus /> Add a site
            </button>
          )}

          {showForm && (
            <AddSiteForm
              onCancel={() => setShowForm(false)}
              onSaved={() => {
                setShowForm(false);
                load();
              }}
              toast={toast}
            />
          )}

          <div style={{ marginTop: 40 }}>
            <div className="eyebrow" style={{ marginBottom: 12 }}>Your sites</div>
            {loading ? (
              <div className="app-callout"><div>Loading…</div></div>
            ) : sites.length === 0 ? (
              <div className="app-callout">
                <div style={{ color: 'var(--fg-muted)' }}>
                  No sites connected yet.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {sites.map((s) => (
                  <SiteRow
                    key={s.id}
                    site={s}
                    onDelete={() => handleDelete(s)}
                    onTogglePause={() => handleTogglePause(s)}
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

function SiteRow({ site, onDelete, onTogglePause }) {
  const cfg = site.cms_config ?? {};
  return (
    <div className="app-tile" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span className={`chip ${site.is_active ? 'chip-faint' : 'chip-warn'}`}>
          {site.cms_type}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: 'var(--fg)' }}>{site.name}</div>
          {cfg.url && (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {cfg.url}
              {cfg.username ? ` · ${cfg.username}` : ''}
            </div>
          )}
        </div>
        {!site.is_active && <span className="chip chip-warn">Paused</span>}
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-sm" onClick={onTogglePause}>
            {site.is_active ? 'Pause' : 'Resume'}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDelete}>
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}

function AddSiteForm({ onCancel, onSaved, toast }) {
  const [cmsType, setCmsType] = useState('wordpress');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(null); // null | { user_name, base_url }
  const [saving, setSaving] = useState(false);

  // Re-verify if any credential changes after a previous verify.
  useEffect(() => {
    setVerified(null);
  }, [url, username, appPassword]);

  const handleVerify = async () => {
    setVerifying(true);
    const result = await verifyWordPress({
      url,
      username,
      app_password: appPassword,
    });
    setVerifying(false);
    if (!result.ok) {
      toast(result.error || 'Verify failed.', { tone: 'danger' });
      return;
    }
    if (result.ok && result.error) {
      // The function returns { ok: false, error } as 200 for predictable
      // user-facing failures. Treat that path the same.
      toast(result.error, { tone: 'danger' });
      return;
    }
    setVerified({ user_name: result.user_name, base_url: result.base_url });
    toast(`Connected as ${result.user_name}.`, { tone: 'success' });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!verified) {
      toast('Verify the connection first.', { tone: 'danger' });
      return;
    }
    setSaving(true);
    const { error } = await supabase.from('sites').insert({
      name: name.trim() || verified.base_url,
      domain: new URL(verified.base_url).hostname,
      cms_type: cmsType,
      cms_config: {
        url: verified.base_url,
        username: username.trim(),
        app_password: appPassword.replace(/^\s+|\s+$/g, ''),
      },
      is_active: true,
    });
    setSaving(false);
    if (error) {
      toast(error.message, { tone: 'danger' });
      return;
    }
    toast('Site connected.', { tone: 'success' });
    onSaved();
  };

  return (
    <form onSubmit={handleSave} className="app-callout" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 16, marginTop: 24 }}>
      <div>
        <div className="eyebrow" style={{ marginBottom: 8 }}>New site</div>
      </div>

      <label className="field">
        <span className="field-label">Platform</span>
        <select
          className="input"
          value={cmsType}
          onChange={(e) => setCmsType(e.target.value)}
        >
          {CMS_TYPES.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.available}>
              {c.label}
              {!c.available ? ' — coming soon' : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field-label">Site name</span>
        <input
          className="input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Acme blog"
          maxLength={80}
        />
      </label>

      <label className="field">
        <span className="field-label">WordPress site URL</span>
        <input
          className="input"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://yoursite.com"
          autoComplete="off"
          required
        />
      </label>

      <label className="field">
        <span className="field-label">Username</span>
        <input
          className="input"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="WP admin username"
          autoComplete="off"
          required
        />
      </label>

      <label className="field">
        <span className="field-label">
          Application Password
          <a
            className="field-label-action"
            href="https://wordpress.org/documentation/article/application-passwords/"
            target="_blank"
            rel="noreferrer"
          >
            How?
          </a>
        </span>
        <input
          className="input"
          type="password"
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value)}
          placeholder="abcd efgh ijkl mnop qrst uvwx"
          autoComplete="new-password"
          required
        />
        <span style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
          WP Admin → Users → Profile → Application Passwords. The 24-char string with spaces.
        </span>
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {verified ? (
          <span className="chip chip-faint">
            <Check size={11} /> Verified as {verified.user_name}
          </span>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={handleVerify}
            disabled={!url || !username || !appPassword || verifying}
          >
            {verifying ? 'Verifying…' : 'Verify connection'}
          </button>
        )}

        <div style={{ flex: 1 }} />

        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!verified || saving}
        >
          {saving ? 'Saving…' : 'Save site'}
        </button>
      </div>
    </form>
  );
}
