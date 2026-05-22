// publish-article
//
// Publishes a Bylined article to a connected CMS. Supported: WordPress,
// Webflow, Shopify, a generic signed webhook, and the Bylined-hosted blog.
//
// Input:  { article_id, site_id, live? }   live=true → status="publish",
//                                          else status="draft" so the user
//                                          can review in WP admin first.
//
// Auth: JWT-scoped client reads the article + site row. RLS guarantees the
// caller owns both. The site config (URL + Application Password) is kept
// server-side here — the frontend never sees the password again after save.
//
// On success we update articles row: status='published'/'draft', site_id,
// cms_post_id, cms_post_url, published_at. (status='draft' even for WP-side
// drafts is wrong; we use 'published' if the WP status is 'publish', else
// keep ours as 'draft' until a future "publish live" action.)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
// Used only on the admin path — lets a founder approving a customer's
// article from the review queue publish an article they don't own.
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ─── Markdown rendering (mirrors engine/src/markdown.ts) ───────────────
// Kept inlined here so this edge function has zero local imports and can
// be deployed without a bundling step. Worth de-duping into a shared
// helper if we add a third consumer.

interface Receipt {
  id: number;
  source_url: string;
  passage: string;
  verified: boolean;
  wayback_url?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownToHtml(md: string): string {
  let html = md;
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?:^|[^_])_([^_\n]+)_(?:[^_]|$)/g, (m, inner) =>
    m.replace(`_${inner}_`, `<em>${inner}</em>`)
  );
  html = html.replace(
    /\[\^(\d+)\]/g,
    '<sup><a href="#receipt-$1" id="cite-$1" rel="nofollow">$1</a></sup>'
  );
  const blocks = html.split(/\n\s*\n+/);
  return blocks
    .map((b) => {
      const t = b.trim();
      if (!t) return "";
      if (/^<(h[1-6]|ul|ol|blockquote|pre|table|div)\b/i.test(t)) return t;
      return `<p>${t}</p>`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function buildSourcesHtml(receipts: Receipt[]): string {
  const verified = receipts.filter((r) => r.verified && r.source_url);
  if (verified.length === 0) return "";
  const items = verified
    .map((r) => {
      const passage = escapeHtml(r.passage);
      const url = escapeHtml(r.source_url);
      const wayback = r.wayback_url
        ? ` &nbsp;·&nbsp; <a href="${escapeHtml(r.wayback_url)}" rel="nofollow">archive</a>`
        : "";
      return `  <li id="receipt-${r.id}">&ldquo;${passage}&rdquo; &mdash; <a href="${url}" rel="nofollow">${url}</a>${wayback}</li>`;
    })
    .join("\n");
  return `<h2>Sources</h2>\n<ol>\n${items}\n</ol>`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 70);
}

// ─── Publishers ────────────────────────────────────────────────────────

interface WpConfig {
  url: string;
  username: string;
  app_password: string;
}

async function publishWordPress(
  cfg: WpConfig,
  args: {
    title: string;
    content: string;
    excerpt: string;
    slug: string;
    live: boolean;
    // When set, PUT to /posts/{id} instead of POSTing a new one. Used
    // when the article has already been pushed to this site once before.
    existing_post_id?: string | null;
  }
): Promise<{ id: number; url: string; status: string; edit_url: string }> {
  const base = cfg.url.replace(/\/+$/, "");
  const status = args.live ? "publish" : "draft";
  const creds = btoa(`${cfg.username}:${cfg.app_password}`);

  const isUpdate = Boolean(args.existing_post_id);
  const endpoint = isUpdate
    ? `${base}/wp-json/wp/v2/posts/${args.existing_post_id}`
    : `${base}/wp-json/wp/v2/posts`;

  const res = await fetch(endpoint, {
    method: isUpdate ? "PUT" : "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/json",
      "User-Agent": "BylinedBot/0.1 (+https://getbylined.com/bot)",
    },
    body: JSON.stringify({
      title: args.title,
      content: args.content,
      excerpt: args.excerpt,
      slug: args.slug,
      status,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    let detail = await res.text();
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.message) detail = parsed.message;
    } catch {
      /* keep raw */
    }
    // 404 on PUT = the WP post was deleted on their side. Caller can
    // detect this by status text and retry as a create. For now we just
    // surface the WP error so the UI shows it.
    throw new Error(`WordPress ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as {
    id: number;
    link: string;
    slug: string;
    status: string;
  };

  // Build the public URL from the site's configured base + WP slug rather
  // than relying on WP's `link` field, which echoes WP's `home` option.
  // Behind a reverse proxy / tunnel, `home` often differs from how users
  // (and our edge function) actually reach the site. Falling back to
  // `link` if the slug shape isn't what we expect.
  let publicUrl = data.link;
  if (data.slug) {
    publicUrl = `${base}/${data.slug}/`;
  }

  return {
    id: data.id,
    url: publicUrl,
    status: data.status,
    edit_url: `${base}/wp-admin/post.php?post=${data.id}&action=edit`,
  };
}

// ─── Webflow publisher ─────────────────────────────────────────────────

interface WfConfig {
  api_token: string;
  site_id: string;
  site_short_name?: string;
  collection_id: string;
  collection_slug?: string;
  mapping: {
    title: string;
    slug: string;
    body: string;
    excerpt?: string;
  };
}

const WEBFLOW_BASE = "https://api.webflow.com/v2";

async function wfFetch(token: string, path: string, init: RequestInit = {}) {
  return fetch(`${WEBFLOW_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "BylinedBot/0.1 (+https://getbylined.com/bot)",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
}

async function publishWebflow(
  cfg: WfConfig,
  args: {
    title: string;
    content: string;
    excerpt: string;
    slug: string;
    live: boolean;
    existing_post_id?: string | null;
  }
): Promise<{ id: string; url: string; status: string; edit_url: string }> {
  // Build fieldData from the user-confirmed mapping. Webflow's API
  // requires the slugs we discovered at site-setup time.
  const fieldData: Record<string, string> = {
    [cfg.mapping.title]: args.title,
    [cfg.mapping.slug]: args.slug,
    [cfg.mapping.body]: args.content,
  };
  if (cfg.mapping.excerpt && args.excerpt) {
    fieldData[cfg.mapping.excerpt] = args.excerpt;
  }

  const body = {
    isArchived: false,
    isDraft: !args.live, // Webflow's "draft" = staged in CMS, not visible on the live site
    fieldData,
  };

  const isUpdate = Boolean(args.existing_post_id);
  const endpoint = isUpdate
    ? `/collections/${cfg.collection_id}/items/${args.existing_post_id}`
    : `/collections/${cfg.collection_id}/items`;

  const res = await wfFetch(cfg.api_token, endpoint, {
    method: isUpdate ? "PATCH" : "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = await res.text();
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.message) detail = parsed.message;
    } catch {
      /* keep raw */
    }
    throw new Error(`Webflow ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as { id: string; lastUpdated?: string };

  // Live publish — Webflow distinguishes between "staged in CMS" and
  // "deployed to the live site". We push to the .webflow.io subdomain
  // by default. Custom domains are a v2 follow-up.
  if (args.live) {
    const pubRes = await wfFetch(cfg.api_token, `/sites/${cfg.site_id}/publish`, {
      method: "POST",
      body: JSON.stringify({ publishToWebflowSubdomain: true }),
    });
    if (!pubRes.ok) {
      // Item created/updated, but live publish failed. Surface the
      // partial-success so the user can publish from Webflow's UI if
      // needed.
      const err = await pubRes.text();
      throw new Error(
        `Webflow item saved (${data.id}) but site publish failed: ${err}`
      );
    }
  }

  // Build URLs. Webflow's API doesn't return a public URL on item
  // create — we synthesize it from site shortName + collection slug +
  // item slug. If those weren't captured at setup time, fall back to a
  // CMS-side edit URL only.
  let publicUrl = "";
  if (cfg.site_short_name && cfg.collection_slug) {
    publicUrl = `https://${cfg.site_short_name}.webflow.io/${cfg.collection_slug}/${args.slug}`;
  }
  const editUrl = `https://webflow.com/dashboard/sites/${cfg.site_id}/cms/${cfg.collection_id}/items/${data.id}`;

  return {
    id: data.id,
    url: publicUrl || editUrl,
    status: args.live ? "publish" : "draft",
    edit_url: editUrl,
  };
}

// ─── Webhook publisher ─────────────────────────────────────────────────
//
// Universal escape hatch: POST the article to a URL the customer owns,
// so Bylined can reach any platform the native publishers don't (Zapier,
// Make, n8n, a custom endpoint). When a secret is set, the body carries
// an HMAC-SHA256 signature so the receiver can verify it's really us.

interface WebhookConfig {
  url: string;
  secret?: string;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function publishWebhook(
  cfg: WebhookConfig,
  args: {
    article_id: string;
    title: string;
    slug: string;
    meta_description: string;
    html: string;
    markdown: string;
    receipts: Receipt[];
    live: boolean;
  },
): Promise<{ id: string; url: string; status: string; edit_url: string }> {
  const payload = {
    event: "article.published",
    article_id: args.article_id,
    title: args.title,
    slug: args.slug,
    meta_description: args.meta_description,
    html: args.html,
    markdown: args.markdown,
    receipts: args.receipts,
    live: args.live,
    published_at: new Date().toISOString(),
  };
  const bodyStr = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "BylinedBot/0.1 (+https://getbylined.com/bot)",
  };
  if (cfg.secret) {
    headers["X-Bylined-Signature"] =
      `sha256=${await hmacSha256Hex(cfg.secret, bodyStr)}`;
  }

  const res = await fetch(cfg.url, {
    method: "POST",
    headers,
    body: bodyStr,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `Webhook ${res.status}: ${detail || "endpoint rejected the POST"}`,
    );
  }
  return {
    id: "webhook",
    url: cfg.url,
    status: args.live ? "publish" : "draft",
    edit_url: cfg.url,
  };
}

// ─── Shopify publisher ─────────────────────────────────────────────────
//
// Posts to a Shopify storefront blog via the Admin API. The customer
// supplies a custom-app Admin API access token + the numeric blog ID.
// NOTE: shipped without a live test store — the first real publish is
// the first real verification.

interface ShopifyConfig {
  shop_domain: string;
  access_token: string;
  blog_id: string;
}

const SHOPIFY_API_VERSION = "2024-10";

async function publishShopify(
  cfg: ShopifyConfig,
  args: {
    title: string;
    content: string;
    excerpt: string;
    slug: string;
    live: boolean;
    existing_post_id?: string | null;
  },
): Promise<{ id: string; url: string; status: string; edit_url: string }> {
  const shop = cfg.shop_domain
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  const apiBase = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}`;
  const headers = {
    "X-Shopify-Access-Token": cfg.access_token,
    "Content-Type": "application/json",
    "User-Agent": "BylinedBot/0.1 (+https://getbylined.com/bot)",
  };

  const isUpdate = Boolean(args.existing_post_id);
  const endpoint = isUpdate
    ? `${apiBase}/blogs/${cfg.blog_id}/articles/${args.existing_post_id}.json`
    : `${apiBase}/blogs/${cfg.blog_id}/articles.json`;

  const articlePayload: Record<string, unknown> = {
    title: args.title,
    body_html: args.content,
    handle: args.slug,
    published: args.live, // Shopify: published=true → visible on the storefront
  };
  if (args.excerpt) articlePayload.summary_html = args.excerpt;

  const res = await fetch(endpoint, {
    method: isUpdate ? "PUT" : "POST",
    headers,
    body: JSON.stringify({ article: articlePayload }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    let detail = await res.text().catch(() => "");
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.errors) detail = JSON.stringify(parsed.errors);
    } catch {
      /* keep raw */
    }
    throw new Error(`Shopify ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as { article: { id: number; handle: string } };
  const a = data.article;

  // The article response has no public URL. Build one from the blog's
  // handle (one extra GET); fall back to the admin URL if that fails.
  const adminUrl = `https://${shop}/admin/articles/${a.id}`;
  let publicUrl = adminUrl;
  try {
    const blogRes = await fetch(`${apiBase}/blogs/${cfg.blog_id}.json`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (blogRes.ok) {
      const blog = (await blogRes.json()) as { blog?: { handle?: string } };
      if (blog.blog?.handle) {
        publicUrl = `https://${shop}/blogs/${blog.blog.handle}/${a.handle}`;
      }
    }
  } catch {
    /* keep the admin-URL fallback */
  }

  return {
    id: String(a.id),
    url: publicUrl,
    status: args.live ? "publish" : "draft",
    edit_url: adminUrl,
  };
}

// ─── Bylined-hosted blog publisher ─────────────────────────────────────
//
// Writes a row to public.blog_posts (anon-readable when status='published'),
// then fires the marketing site's Vercel Deploy Hook to trigger a rebuild.
// The marketing build script reads blog_posts and emits static HTML at
// /blog and /blog/{slug}.
//
// Config: empty — there's only ever one hosted destination
// (BYLINED_HOSTED_DEPLOY_HOOK env on the edge function). The user does
// have to create a `sites` row with cms_type='bylined_hosted' so the rest
// of the publish flow has somewhere to attach (site_id is required on
// articles). We accept any non-null cms_config.

const BYLINED_HOSTED_DEPLOY_HOOK = Deno.env.get(
  "BYLINED_HOSTED_DEPLOY_HOOK"
);
const BYLINED_HOSTED_PUBLIC_BASE =
  Deno.env.get("BYLINED_HOSTED_PUBLIC_BASE") ?? "https://getbylined.com";

interface BylinedHostedResult {
  id: string;
  url: string;
  edit_url: string;
  status: string;
}

async function publishBylinedHosted(
  userClient: ReturnType<typeof createClient>,
  args: {
    user_id: string;
    article_id: string;
    site_id: string;
    title: string;
    meta_description: string;
    body_html: string;
    sources_html: string;
    slug: string;
    live: boolean;
  }
): Promise<BylinedHostedResult> {
  const status = args.live ? "published" : "draft";
  const publishedAt = args.live ? new Date().toISOString() : null;

  // Upsert by (article_id, site_id) — re-publish updates the row, doesn't
  // create a duplicate. RLS owner_full_access gates the write.
  const { data, error } = await userClient
    .from("blog_posts")
    .upsert(
      {
        user_id: args.user_id,
        article_id: args.article_id,
        site_id: args.site_id,
        slug: args.slug,
        title: args.title,
        meta_description: args.meta_description,
        body_html: args.body_html,
        sources_html: args.sources_html,
        status,
        published_at: publishedAt,
      },
      { onConflict: "article_id,site_id" }
    )
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`blog_posts upsert failed: ${error?.message ?? "no row"}`);
  }

  // Fire the rebuild hook only for live publishes — drafts shouldn't
  // burn a Vercel build. If the hook isn't configured (local dev), no-op.
  if (args.live && BYLINED_HOSTED_DEPLOY_HOOK) {
    try {
      await fetch(BYLINED_HOSTED_DEPLOY_HOOK, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      // Don't fail the publish if the rebuild trigger flaps — the row
      // is committed and the next deploy will pick it up. Log so we
      // can notice in Sentry.
      console.error("BYLINED_HOSTED_DEPLOY_HOOK failed:", e);
    }
  }

  const base = BYLINED_HOSTED_PUBLIC_BASE.replace(/\/+$/, "");
  const url = `${base}/blog/${args.slug}`;
  return {
    id: data.id as string,
    url,
    edit_url: url, // No separate admin URL — editing happens in Bylined itself
    status: args.live ? "publish" : "draft",
  };
}

// ─── Handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader) return jsonResponse(401, { error: "Missing authorization" });

    // JWT-scoped client — RLS gates which articles + sites this user can see.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) return jsonResponse(401, { error: "Unauthorized" });

    // Admin path: a founder approving a customer's article from the
    // review queue publishes an article they don't own. For admins we
    // run every DB op with the service-role client so RLS doesn't hide
    // the other account's article + site rows. Non-admins keep the
    // JWT-scoped client — RLS still enforces ownership for them.
    const { data: callerProfile } = await userClient
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle();
    const isAdmin = callerProfile?.is_admin === true;
    const db = isAdmin
      ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false },
        })
      : userClient;

    const body = (await req.json().catch(() => null)) as
      | { article_id?: string; site_id?: string; live?: boolean }
      | null;
    if (!body?.article_id || !body?.site_id) {
      return jsonResponse(400, { error: "article_id and site_id required" });
    }

    // Fetch article. Non-admin: RLS requires ownership. Admin: service-
    // role client, so any account's article resolves.
    const { data: article, error: aErr } = await db
      .from("articles")
      .select(
        "id, user_id, title, meta_description, body_markdown, receipts, " +
          "site_id, cms_post_id"
      )
      .eq("id", body.article_id)
      .single();
    if (aErr || !article) {
      return jsonResponse(404, { error: "Article not found." });
    }

    // Fetch site (non-admin: RLS requires ownership).
    const { data: site, error: sErr } = await db
      .from("sites")
      .select("id, name, cms_type, cms_config, is_active")
      .eq("id", body.site_id)
      .single();
    if (sErr || !site) {
      return jsonResponse(404, { error: "Site not found." });
    }
    if (!site.is_active) {
      return jsonResponse(400, { error: "Site is paused." });
    }

    // Render the post body once — same shape regardless of CMS.
    const bodyHtml = markdownToHtml(article.body_markdown);
    const sourcesHtml = buildSourcesHtml(
      (article.receipts ?? []) as Receipt[]
    );
    const fullContent = sourcesHtml ? `${bodyHtml}\n\n${sourcesHtml}` : bodyHtml;
    const slug = slugify(article.title);
    const live = body.live === true;

    let result: { id: string; url: string; edit_url?: string; status: string };

    if (site.cms_type === "wordpress") {
      const cfg = site.cms_config as Partial<WpConfig>;
      if (!cfg?.url || !cfg?.username || !cfg?.app_password) {
        return jsonResponse(400, { error: "Site is missing WordPress credentials." });
      }
      // Re-publish path: if this article was previously pushed to THIS
      // site, update the existing WP post instead of creating a new one.
      // Different-site re-publish creates a fresh post (we only track one
      // (site, post) pair per article).
      const existingPostId =
        article.site_id === site.id ? article.cms_post_id : null;
      const r = await publishWordPress(cfg as WpConfig, {
        title: article.title,
        content: fullContent,
        excerpt: article.meta_description ?? "",
        slug,
        live,
        existing_post_id: existingPostId,
      });
      result = { id: String(r.id), url: r.url, edit_url: r.edit_url, status: r.status };
    } else if (site.cms_type === "webflow") {
      const cfg = site.cms_config as Partial<WfConfig>;
      if (
        !cfg?.api_token ||
        !cfg?.site_id ||
        !cfg?.collection_id ||
        !cfg?.mapping?.title ||
        !cfg?.mapping?.slug ||
        !cfg?.mapping?.body
      ) {
        return jsonResponse(400, {
          error:
            "Site is missing Webflow setup (API token, site, collection, " +
            "or required field mapping).",
        });
      }
      const existingPostId =
        article.site_id === site.id ? article.cms_post_id : null;
      const r = await publishWebflow(cfg as WfConfig, {
        title: article.title,
        content: fullContent,
        excerpt: article.meta_description ?? "",
        slug,
        live,
        existing_post_id: existingPostId,
      });
      result = { id: r.id, url: r.url, edit_url: r.edit_url, status: r.status };
    } else if (site.cms_type === "bylined_hosted") {
      const r = await publishBylinedHosted(db, {
        user_id: article.user_id,
        article_id: article.id,
        site_id: site.id,
        title: article.title,
        meta_description: article.meta_description ?? "",
        body_html: bodyHtml,
        sources_html: sourcesHtml,
        slug,
        live,
      });
      result = { id: r.id, url: r.url, edit_url: r.edit_url, status: r.status };
    } else if (site.cms_type === "webhook") {
      const cfg = site.cms_config as Partial<WebhookConfig>;
      if (!cfg?.url) {
        return jsonResponse(400, { error: "Site is missing a webhook URL." });
      }
      const r = await publishWebhook(cfg as WebhookConfig, {
        article_id: article.id,
        title: article.title,
        slug,
        meta_description: article.meta_description ?? "",
        html: fullContent,
        markdown: article.body_markdown,
        receipts: (article.receipts ?? []) as Receipt[],
        live,
      });
      result = { id: r.id, url: r.url, edit_url: r.edit_url, status: r.status };
    } else if (site.cms_type === "shopify") {
      const cfg = site.cms_config as Partial<ShopifyConfig>;
      if (!cfg?.shop_domain || !cfg?.access_token || !cfg?.blog_id) {
        return jsonResponse(400, {
          error:
            "Site is missing Shopify credentials (shop domain, access " +
            "token, or blog ID).",
        });
      }
      const existingPostId =
        article.site_id === site.id ? article.cms_post_id : null;
      const r = await publishShopify(cfg as ShopifyConfig, {
        title: article.title,
        content: fullContent,
        excerpt: article.meta_description ?? "",
        slug,
        live,
        existing_post_id: existingPostId,
      });
      result = { id: r.id, url: r.url, edit_url: r.edit_url, status: r.status };
    } else {
      return jsonResponse(400, {
        error: `Publishing to ${site.cms_type} isn't wired yet.`,
      });
    }

    // Mirror the published state onto our article. Status='published' only
    // when the CMS-side status is the live one; otherwise keep our status
    // as 'draft' (post exists in CMS but is staged).
    const wpLive = result.status === "publish";
    await db
      .from("articles")
      .update({
        site_id: site.id,
        cms_post_id: result.id,
        cms_post_url: result.url,
        status: wpLive ? "published" : "draft",
        published_at: wpLive ? new Date().toISOString() : null,
      })
      .eq("id", article.id);

    return jsonResponse(200, {
      ok: true,
      url: result.url,
      edit_url: result.edit_url,
      cms_status: result.status,
      live: wpLive,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("publish-article error:", msg);
    return jsonResponse(500, { error: msg });
  }
});
