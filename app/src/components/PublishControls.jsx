// Site picker + Publish/Re-publish button. Shared by the dashboard
// article rows and the article detail page. Calls the publish-article
// edge function via lib/sites.js.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { publishArticle } from '../lib/sites.js';

export default function PublishControls({ article, sites, onPublished, toast }) {
  const [siteId, setSiteId] = useState(article.site_id ?? sites[0]?.id ?? '');
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);

  // Keep the dropdown in sync with the active sites list as it loads.
  useEffect(() => {
    if (!siteId && sites.length > 0) setSiteId(sites[0].id);
  }, [sites, siteId]);

  if (sites.length === 0) {
    return (
      <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        Connect a site at <Link to="/app/sites">/app/sites</Link> to publish.
      </span>
    );
  }

  const handlePublish = async () => {
    if (!siteId) return;
    setBusy(true);
    const result = await publishArticle({
      article_id: article.id,
      site_id: siteId,
      live,
    });
    setBusy(false);
    if (!result.ok) {
      toast(result.error || 'Publish failed.', { tone: 'danger' });
      return;
    }
    toast(
      result.live ? 'Published live.' : 'Draft created on the site.',
      { tone: 'success' }
    );
    onPublished?.();
  };

  return (
    <>
      <select
        className="input"
        value={siteId}
        onChange={(e) => setSiteId(e.target.value)}
        disabled={busy}
        style={{ width: 'auto', minWidth: 160, height: 28, fontSize: 12.5 }}
      >
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({s.cms_type})
          </option>
        ))}
      </select>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          color: 'var(--fg-muted)',
        }}
      >
        <input
          type="checkbox"
          checked={live}
          onChange={(e) => setLive(e.target.checked)}
          disabled={busy}
        />
        Publish live
      </label>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={handlePublish}
        disabled={busy || !siteId}
      >
        {busy ? 'Publishing…' : article.cms_post_id ? 'Re-publish' : 'Publish'}
      </button>
    </>
  );
}
