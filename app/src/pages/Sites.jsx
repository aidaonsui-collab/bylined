// Sites — connect a CMS where Bylined publishes articles.
//
// Supported: WordPress (URL + username + Application Password) and
// Webflow (API token → site → collection → auto-detected field mapping).
//
// Credentials leave the browser exactly twice:
//   1. Verify — POST to verify-wordpress-site / verify-webflow
//   2. Save   — INSERT into public.sites (cms_config jsonb)
// We never read the password/token back into the form for editing —
// instead, "edit" is delete + re-add. Simpler and safer.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store.jsx';
import { useToast } from '../components/Toast.jsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';
import { CMS_TYPES, verifyWordPress, verifyWebflow } from '../lib/sites.js';

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
  // Platform selector lives in the parent so switching wipes platform-
  // specific state instead of leaking values across forms.
  const [cmsType, setCmsType] = useState('wordpress');
  const [name, setName] = useState('');

  return (
    <div className="app-callout" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 16, marginTop: 24 }}>
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

      {cmsType === 'wordpress' ? (
        <WordPressFields
          name={name}
          onCancel={onCancel}
          onSaved={onSaved}
          toast={toast}
        />
      ) : cmsType === 'webflow' ? (
        <WebflowFields
          name={name}
          onCancel={onCancel}
          onSaved={onSaved}
          toast={toast}
        />
      ) : null}
    </div>
  );
}

function WordPressFields({ name, onCancel, onSaved, toast }) {
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(null); // null | { user_name, base_url }
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Editing any credential invalidates a previous verify and clears the
  // last error so the user gets a clean slate for the next probe.
  useEffect(() => {
    setVerified(null);
    setError(null);
  }, [url, username, appPassword]);

  const credsFilled = url && username && appPassword;

  const handleVerify = async () => {
    setVerifying(true);
    setError(null);
    const result = await verifyWordPress({
      url,
      username,
      app_password: appPassword,
    });
    setVerifying(false);
    // verify-wordpress-site returns 200 with { ok: false, error } for
    // predictable failures (auth, DNS, 404), and surfaces them via the
    // `result.ok=false` path here.
    if (!result.ok) {
      setError(result.error || 'Verify failed.');
      return;
    }
    setVerified({ user_name: result.user_name, base_url: result.base_url });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!verified) {
      setError('Click "Verify connection" first — Save activates after a successful test.');
      return;
    }
    setSaving(true);
    setError(null);
    const { error: insertError } = await supabase.from('sites').insert({
      name: name.trim() || verified.base_url,
      domain: new URL(verified.base_url).hostname,
      cms_type: 'wordpress',
      cms_config: {
        url: verified.base_url,
        username: username.trim(),
        app_password: appPassword.replace(/^\s+|\s+$/g, ''),
      },
      is_active: true,
    });
    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    toast('Site connected.', { tone: 'success' });
    onSaved();
  };

  return (
    <form
      onSubmit={handleSave}
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
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
        {verified ? (
          <>
            <span className="chip chip-faint" title={verified.base_url}>
              <Check size={11} /> Verified as {verified.user_name}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={handleVerify}
              disabled={verifying || saving}
              title="Re-test the connection"
            >
              {verifying ? 'Re-verifying…' : 'Re-verify'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              onClick={handleVerify}
              disabled={!credsFilled || verifying}
            >
              {verifying ? 'Verifying…' : 'Verify connection'}
            </button>
            {!verifying && (
              <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                {credsFilled
                  ? 'Tests the credentials before saving.'
                  : 'Fill in URL + username + password to enable.'}
              </span>
            )}
          </>
        )}

        <div style={{ flex: 1 }} />

        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!verified || saving}
          title={!verified ? 'Verify the connection first.' : undefined}
        >
          {saving ? 'Saving…' : 'Save site'}
        </button>
      </div>
    </form>
  );
}

function WebflowFields({ name, onCancel, onSaved, toast }) {
  const [apiToken, setApiToken] = useState('');
  const [sites, setSites] = useState(null); // null = not discovered yet
  const [siteId, setSiteId] = useState('');
  const [collections, setCollections] = useState(null);
  const [collectionId, setCollectionId] = useState('');
  const [schema, setSchema] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [mappingComplete, setMappingComplete] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [loading, setLoading] = useState(false); // collections / schema
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Editing the token throws away every cascade-level state — selectedSite,
  // collections, mapping, etc. — since they're only valid for that token.
  useEffect(() => {
    setSites(null);
    setSiteId('');
    setCollections(null);
    setCollectionId('');
    setSchema(null);
    setMapping(null);
    setMappingComplete(false);
    setError(null);
  }, [apiToken]);

  // Selected site changed → invalidate collection-level state.
  useEffect(() => {
    setCollections(null);
    setCollectionId('');
    setSchema(null);
    setMapping(null);
    setMappingComplete(false);
  }, [siteId]);

  const handleDiscover = async () => {
    setDiscovering(true);
    setError(null);
    const result = await verifyWebflow({ api_token: apiToken });
    setDiscovering(false);
    if (!result.ok) {
      setError(result.error || 'Could not reach Webflow.');
      return;
    }
    setSites(result.sites ?? []);
    if ((result.sites ?? []).length === 1) {
      setSiteId(result.sites[0].id);
    }
  };

  const handleSiteChange = async (e) => {
    const newSiteId = e.target.value;
    setSiteId(newSiteId);
    if (!newSiteId) return;
    setLoading(true);
    setError(null);
    const result = await verifyWebflow({ api_token: apiToken, site_id: newSiteId });
    setLoading(false);
    if (!result.ok) {
      setError(result.error || 'Could not list collections.');
      return;
    }
    setCollections(result.collections ?? []);
    if ((result.collections ?? []).length === 1) {
      // Auto-select if there's only one collection — saves a click.
      handleCollectionChange({ target: { value: result.collections[0].id } }, newSiteId);
    }
  };

  const handleCollectionChange = async (e, siteIdOverride) => {
    const newColId = e.target.value;
    setCollectionId(newColId);
    if (!newColId) return;
    setLoading(true);
    setError(null);
    const result = await verifyWebflow({
      api_token: apiToken,
      site_id: siteIdOverride ?? siteId,
      collection_id: newColId,
    });
    setLoading(false);
    if (!result.ok) {
      setError(result.error || 'Could not load collection schema.');
      return;
    }
    setSchema(result.schema ?? null);
    setMapping(result.mapping ?? null);
    setMappingComplete(Boolean(result.mapping_complete));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!mappingComplete) {
      setError('Required field mapping is incomplete — see the Mapping section above.');
      return;
    }
    setSaving(true);
    setError(null);

    const site = sites?.find((s) => s.id === siteId);
    const collection = collections?.find((c) => c.id === collectionId);
    if (!site || !collection || !mapping) {
      setSaving(false);
      setError('Site or collection state missing — try Discover again.');
      return;
    }

    const { error: insertError } = await supabase.from('sites').insert({
      name: name.trim() || `${site.displayName} · ${collection.displayName}`,
      domain: `${site.shortName}.webflow.io`,
      cms_type: 'webflow',
      cms_config: {
        api_token: apiToken.trim(),
        site_id: site.id,
        site_short_name: site.shortName,
        site_display_name: site.displayName,
        collection_id: collection.id,
        collection_slug: collection.slug,
        collection_display_name: collection.displayName,
        mapping: {
          title: mapping.title,
          slug: mapping.slug,
          body: mapping.body,
          ...(mapping.excerpt ? { excerpt: mapping.excerpt } : {}),
        },
      },
      is_active: true,
    });
    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    toast('Site connected.', { tone: 'success' });
    onSaved();
  };

  const tokenFilled = apiToken.trim().length > 10;

  return (
    <form
      onSubmit={handleSave}
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      <label className="field">
        <span className="field-label">
          Webflow API token
          <a
            className="field-label-action"
            href="https://developers.webflow.com/data/docs/access-token-management"
            target="_blank"
            rel="noreferrer"
          >
            How?
          </a>
        </span>
        <input
          className="input"
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder="Site Settings → Apps & integrations → API access"
          autoComplete="new-password"
          required
        />
        <span style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
          Permissions needed: CMS read+write, Sites read+publish.
        </span>
      </label>

      {sites && sites.length > 0 && (
        <label className="field">
          <span className="field-label">Webflow site</span>
          <select
            className="input"
            value={siteId}
            onChange={handleSiteChange}
            disabled={loading || saving}
          >
            <option value="">— choose —</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName} ({s.shortName}.webflow.io)
              </option>
            ))}
          </select>
        </label>
      )}

      {sites && sites.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          The token authenticated, but it has no sites attached. Re-issue
          it with read+write CMS access on the site you want to publish to.
        </div>
      )}

      {collections && collections.length > 0 && (
        <label className="field">
          <span className="field-label">Collection</span>
          <select
            className="input"
            value={collectionId}
            onChange={handleCollectionChange}
            disabled={loading || saving}
          >
            <option value="">— choose —</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} ({c.slug})
              </option>
            ))}
          </select>
        </label>
      )}

      {collections && collections.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          This site has no CMS collections. Add one in Webflow first.
        </div>
      )}

      {schema && mapping && (
        <div
          className="cito-surface"
          style={{ padding: 12, fontSize: 13 }}
        >
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            Field mapping {mappingComplete ? '· auto-detected' : '· incomplete'}
          </div>
          <MappingRow label="Title" slug={mapping.title} required />
          <MappingRow label="Slug" slug={mapping.slug} required />
          <MappingRow label="Body" slug={mapping.body} required />
          <MappingRow label="Excerpt" slug={mapping.excerpt} />
          {!mappingComplete && (
            <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 8 }}>
              Couldn't auto-detect a required field. Rename your collection's
              fields to standard slugs (<code>name</code>, <code>slug</code>,
              and a RichText field with "body" or "post" in its slug) and
              click the collection again to re-detect.
            </div>
          )}
        </div>
      )}

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
        {!sites ? (
          <>
            <button
              type="button"
              className="btn"
              onClick={handleDiscover}
              disabled={!tokenFilled || discovering}
            >
              {discovering ? 'Discovering…' : 'Discover sites'}
            </button>
            {!discovering && (
              <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                {tokenFilled
                  ? 'Lists Webflow sites this token can access.'
                  : 'Paste the API token to enable.'}
              </span>
            )}
          </>
        ) : (
          <span className="chip chip-faint" title={`${sites.length} site(s)`}>
            <Check size={11} /> Token verified
          </span>
        )}

        <div style={{ flex: 1 }} />

        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!mappingComplete || saving || loading}
          title={!mappingComplete ? 'Pick a site + collection with a complete mapping.' : undefined}
        >
          {saving ? 'Saving…' : 'Save site'}
        </button>
      </div>
    </form>
  );
}

function MappingRow({ label, slug, required }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '90px 1fr',
        gap: 8,
        padding: '4px 0',
        alignItems: 'center',
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        {label}
        {required && <span style={{ color: 'var(--warn)' }}> *</span>}
      </div>
      <div className="mono" style={{ fontSize: 12.5, color: slug ? 'var(--fg)' : 'var(--fg-subtle)' }}>
        {slug ?? '— not detected —'}
      </div>
    </div>
  );
}
