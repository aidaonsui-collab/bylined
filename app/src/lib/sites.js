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
  {
    id: 'webflow',
    label: 'Webflow',
    available: true,
    helpUrl:
      'https://developers.webflow.com/data/docs/access-token-management',
  },
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

// Webflow's discovery cascade — token (always), site_id (optional),
// collection_id (optional). Each step that's filled in unlocks the next
// piece in the response. See supabase/functions/verify-webflow.
export async function verifyWebflow({ api_token, site_id, collection_id }) {
  const result = await invokeEdgeFunction('verify-webflow', {
    api_token,
    site_id,
    collection_id,
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

// Voice — extract a brand-style fingerprint from a homepage. Backed by
// supabase/functions/extract-voice-fingerprint, which crawls the site,
// hands a sampled corpus to Minimax, and inserts a row in public.voices.
// Wall-clock is ~30–60s; surface a spinner.
export async function extractVoiceFingerprint({ source_url }) {
  const result = await invokeEdgeFunction('extract-voice-fingerprint', {
    source_url,
  });
  if (!result.ok) return result;
  return { ok: true, ...result.data };
}
