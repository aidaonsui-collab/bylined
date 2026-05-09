// Sites helpers — wraps the site-management edge functions.
//
// We never put a CMS password into the browser's bundle or local
// storage. We do read it back from the DB via RLS to display the
// connection status, but for new sites the password leaves the page
// only when the user clicks Save.

import { invokeEdgeFunction } from './stripe.js';

// CMS_TYPES drives the picker on /app/sites. Add new platforms here +
// the supporting edge function logic.
export const CMS_TYPES = [
  {
    id: 'wordpress',
    label: 'WordPress',
    available: true,
    helpUrl:
      'https://wordpress.org/documentation/article/application-passwords/',
  },
  { id: 'webflow', label: 'Webflow', available: false, helpUrl: null },
  { id: 'shopify', label: 'Shopify', available: false, helpUrl: null },
  { id: 'ghost', label: 'Ghost', available: false, helpUrl: null },
];

export async function verifyWordPress({ url, username, app_password }) {
  const result = await invokeEdgeFunction('verify-wordpress-site', {
    url,
    username,
    app_password,
  });
  if (!result.ok) return result;
  return { ok: true, ...result.data };
}

export async function publishArticle({ article_id, site_id, live }) {
  const result = await invokeEdgeFunction('publish-article', {
    article_id,
    site_id,
    live: Boolean(live),
  });
  if (!result.ok) return result;
  return { ok: true, ...result.data };
}
