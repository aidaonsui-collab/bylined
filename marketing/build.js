#!/usr/bin/env node
// Marketing-site build step. (Touched 2026-05-17 to rebuild after a
// bulk publish of 18 backfilled articles direct to blog_posts.)
//
// Runs at Vercel build time. Fetches published rows from public.blog_posts
// (anon-readable per RLS policy in 20260515000002_bylined_hosted_blog.sql),
// then emits static HTML for /blog/index.html and /blog/{slug}.html into
// the marketing tree. Vercel serves the resulting directory unchanged.
//
// Triggers: every git push (normal Vercel deploy) AND every Vercel Deploy
// Hook fire, which the publish-article edge function POSTs when an
// article is published to a bylined_hosted site. ~30s lag between
// publish and the static page going live.
//
// No external deps — uses Node 18+ built-in fetch, fs/promises, and
// template literals. Keep it that way.

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = join(__dirname, 'blog');

// Public anon key for the Bylined Supabase project — safe to commit
// because it's also visible in app.js. Postgres RLS does the gating;
// the anon role can only SELECT blog_posts WHERE status='published'.
const SUPABASE_URL = 'https://boatyhrefcilcxepnbbf.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'sb_publishable_bpV29JM65vrJI1pgUVlKdg_5ZDisV3Y';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

// Shared chrome: nav at top, footer at bottom. Mirrors the structure used
// by privacy.html / terms.html so styling stays consistent without us
// reaching for a templating engine.
function shell({ title, description, bodyClass = '', content, head = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="${esc(description)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:type" content="article" />${head}
<link rel="preconnect" href="https://api.fontshare.com" crossorigin />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="/styles.css" />
</head>
<body class="${bodyClass}">

<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <symbol id="i-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 4 L8 12 L14 20" />
      <circle cx="14" cy="4" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="14" cy="20" r="1.6" fill="currentColor" stroke="none" />
    </symbol>
    <symbol id="i-arrow-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 12h14M13 5l7 7-7 7"/>
    </symbol>
  </defs>
</svg>

<div class="mkt-root">

  <nav class="mkt-nav">
    <div class="mkt-nav-inner">
      <a class="mkt-brand" href="/">
        <span class="brand-mark"><svg class="icon icon-sm"><use href="#i-logo"/></svg></span>
        <span class="brand-wm">bylined</span>
      </a>
      <div class="mkt-nav-links">
        <a href="/receipts">Receipts</a>
        <a href="/pricing">Pricing</a>
        <a href="/blog/">Blog</a>
      </div>
      <div class="mkt-nav-cta">
        <a class="btn btn-sm btn-ghost" href="/sign-in">Sign in</a>
        <a class="btn btn-primary btn-sm" href="/request-access">Request access <svg class="icon icon-sm"><use href="#i-arrow-right"/></svg></a>
      </div>
    </div>
  </nav>

  ${content}

  <footer class="mkt-footer">
    <div class="mkt-container mkt-footer-inner">
      <div class="footer-l">
        <span class="brand-mark"><svg class="icon icon-sm"><use href="#i-logo"/></svg></span>
        <span class="brand-wm">bylined</span>
        <span class="footer-tag">SEO content that shows its work.</span>
      </div>
      <div class="footer-cols">
        <div>
          <div class="footer-h">Product</div>
          <a href="/receipts">Receipts</a>
          <a href="/pricing">Pricing</a>
          <a href="/blog/">Blog</a>
        </div>
        <div>
          <div class="footer-h">Legal</div>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </div>
        <div>
          <div class="footer-h">Get in touch</div>
          <a href="mailto:founders@getbylined.com">founders@getbylined.com</a>
        </div>
      </div>
      <div class="footer-fine">© 2026 Bylined Labs · Built for operators.</div>
    </div>
  </footer>

</div>

</body>
</html>
`;
}

// /blog/ — list of posts. Empty-state copy when no posts exist yet so
// the route resolves cleanly during the Pilot phase.
function renderIndex(posts) {
  const hero = `
  <section class="mkt-section">
    <div class="mkt-container mkt-container-narrow" style="padding-top: 40px;">
      <div style="color: var(--accent-text); font-size: 13px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 8px;">Blog</div>
      <h1 class="mkt-h2 serif" style="font-size: 48px; margin: 0 0 16px;">Written by Bylined, sourced by humans.</h1>
      <p class="mkt-h2-sub">Every post below was generated by the same pipeline you'd use as a customer. Every claim links back to its receipt.</p>
    </div>
  </section>`;

  const list = posts.length === 0
    ? `
  <section class="mkt-section mkt-section-tight">
    <div class="mkt-container mkt-container-narrow">
      <div class="app-callout" style="margin: 0;">
        <div>
          <div class="eyebrow" style="margin-bottom: 8px;">No posts yet</div>
          <p class="app-callout-p">Bylined's own blog is shipping soon — articles publish here automatically as we generate them.</p>
        </div>
      </div>
    </div>
  </section>`
    : `
  <section class="mkt-section mkt-section-tight">
    <div class="mkt-container mkt-container-narrow">
      <div class="blog-list">
        ${posts.map((p) => `
        <a class="blog-card" href="/blog/${esc(p.slug)}/">
          <div class="blog-card-date">${esc(fmtDate(p.published_at))}</div>
          <div class="blog-card-title">${esc(p.title)}</div>
          ${p.meta_description ? `<p class="blog-card-excerpt">${esc(p.meta_description)}</p>` : ''}
          <span class="blog-card-cta">Read <svg class="icon icon-xs"><use href="#i-arrow-right"/></svg></span>
        </a>`).join('\n')}
      </div>
    </div>
  </section>`;

  // Blog-collection structured data + og:image for the index page.
  const blogSchema = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'Bylined Blog',
    description: 'Articles generated by Bylined — every claim sourced and verified.',
    url: `${SITE_ORIGIN}/blog/`,
    publisher: {
      '@type': 'Organization',
      name: 'Bylined',
      url: SITE_ORIGIN,
      logo: { '@type': 'ImageObject', url: OG_IMAGE },
    },
    blogPost: posts.slice(0, 25).map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
      url: `${SITE_ORIGIN}/blog/${p.slug}/`,
      datePublished: p.published_at || undefined,
    })),
  };
  const indexHead = `
<link rel="canonical" href="${SITE_ORIGIN}/blog/" />
<meta property="og:url" content="${SITE_ORIGIN}/blog/" />
<meta property="og:image" content="${OG_IMAGE}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${OG_IMAGE}" />
<script type="application/ld+json">${JSON.stringify(blogSchema).replace(/</g, '\\u003c')}</script>`;

  return shell({
    title: 'Bylined · Blog',
    description: 'Articles generated by Bylined — every claim sourced and verified.',
    bodyClass: 'page-blog',
    head: indexHead,
    content: hero + list,
  });
}

// Site constants for canonical URLs + structured data.
const SITE_ORIGIN = 'https://getbylined.com';
const OG_IMAGE = `${SITE_ORIGIN}/og-default.png`;

// Pull FAQ question/answer pairs out of a rendered article body so we
// can emit FAQPage structured data. The generator ends articles with an
// "## Frequently Asked Questions" H2, then ### question / <p> answer
// pairs — we find that H2 and walk the following h3 + content blocks.
// Returns [] for articles with no FAQ section (e.g. ones generated
// before the structured-article prompt), so older posts degrade
// cleanly with no FAQPage schema rather than breaking.
function extractFaq(bodyHtml) {
  if (!bodyHtml) return [];
  const stripTags = (s) =>
    String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const faqStart = bodyHtml.search(
    /<h2[^>]*>\s*frequently asked questions\s*<\/h2>/i,
  );
  if (faqStart === -1) return [];
  const faqHtml = bodyHtml.slice(faqStart);
  const pairs = [];
  const re = /<h3[^>]*>(.*?)<\/h3>([\s\S]*?)(?=<h3[^>]*>|<h2[^>]*>|$)/gi;
  let m;
  while ((m = re.exec(faqHtml)) !== null) {
    const question = stripTags(m[1]);
    const answer = stripTags(m[2]);
    if (question && answer) pairs.push({ question, answer });
  }
  return pairs;
}

// Build the per-post <head> extras: canonical link, og:image + article
// meta, and JSON-LD BlogPosting structured data. The structured data is
// the highest-leverage AEO signal — it's how AI crawlers map the page
// to an entity and decide it's citable. author/publisher are the
// Bylined org (honest: these articles are generated by Bylined's
// pipeline, not written under a fake human byline). datePublished and
// dateModified both use published_at since blog_posts doesn't track a
// separate edit timestamp.
function postHead(post) {
  const url = `${SITE_ORIGIN}/blog/${post.slug}/`;
  const description = post.meta_description ?? `${post.title} — generated by Bylined.`;
  const published = post.published_at || new Date().toISOString();
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description,
    datePublished: published,
    dateModified: published,
    image: OG_IMAGE,
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    author: { '@type': 'Organization', name: 'Bylined', url: SITE_ORIGIN },
    publisher: {
      '@type': 'Organization',
      name: 'Bylined',
      url: SITE_ORIGIN,
      logo: { '@type': 'ImageObject', url: OG_IMAGE },
    },
  };
  // Escape '<' so a title/description containing "</script>" can't
  // break out of the JSON-LD <script> block.
  const schemaJson = JSON.stringify(schema).replace(/</g, '\\u003c');

  // FAQPage schema — only emitted when the article actually has an
  // FAQ section. FAQPage is one of the most-cited structures in AI
  // search, so this is high-leverage for articles that include it.
  const faq = extractFaq(post.body_html);
  let faqScript = '';
  if (faq.length > 0) {
    const faqSchema = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map((f) => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer },
      })),
    };
    faqScript = `\n<script type="application/ld+json">${JSON.stringify(faqSchema).replace(/</g, '\\u003c')}</script>`;
  }

  return `
<link rel="canonical" href="${esc(url)}" />
<meta property="og:url" content="${esc(url)}" />
<meta property="og:image" content="${OG_IMAGE}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="article:published_time" content="${esc(published)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${OG_IMAGE}" />
<script type="application/ld+json">${schemaJson}</script>${faqScript}`;
}

// /blog/{slug}/ — single post. body_html and sources_html come from
// publish-article's markdownToHtml + buildSourcesHtml (already escaped
// for HTML there), so we inject them raw inside a constrained .legal-prose
// container that styles headings and links.
function renderPost(post) {
  const dateStr = fmtDate(post.published_at);
  return shell({
    title: `${post.title} · Bylined`,
    description: post.meta_description ?? `${post.title} — generated by Bylined.`,
    bodyClass: 'page-blog-post',
    head: postHead(post),
    content: `
  <section class="mkt-section">
    <div class="mkt-container mkt-container-narrow" style="padding-top: 40px;">
      <div style="color: var(--accent-text); font-size: 13px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 8px;">
        <a href="/blog/" style="color: inherit; text-decoration: none;">← Blog</a>
      </div>
      <h1 class="mkt-h2 serif" style="font-size: 44px; margin: 0 0 16px; line-height: 1.15;">${esc(post.title)}</h1>
      ${dateStr ? `<p style="color: var(--fg-subtle); font-size: 13px; margin-bottom: 32px;">Published ${esc(dateStr)} · Generated by Bylined</p>` : ''}

      <article class="legal-prose blog-post-body">
        ${post.body_html ?? ''}
        ${post.sources_html ?? ''}
      </article>

      <div class="app-callout" style="margin-top: 56px;">
        <div>
          <div class="eyebrow" style="margin-bottom: 8px;">See your own AI visibility</div>
          <p class="app-callout-p">Bylined runs the same audit you saw at the top of the homepage, then writes the article that fixes the gap.</p>
        </div>
        <a class="btn btn-primary" href="/" style="margin-left: auto;">Try it free <svg class="icon icon-sm"><use href="#i-arrow-right"/></svg></a>
      </div>
    </div>
  </section>`,
  });
}

// sitemap.xml — every indexable clean URL: the static marketing pages
// plus one entry per published blog post. Helps Google discover posts
// reliably. All URLs are the clean (no-.html) form so we never list a
// URL that cleanUrls would redirect.
function renderSitemap(posts) {
  const staticPaths = ['/', '/receipts', '/pricing', '/blog/', '/privacy', '/terms'];
  const entries = [
    ...staticPaths.map((p) => ({ loc: `${SITE_ORIGIN}${p}` })),
    ...posts.map((p) => ({
      loc: `${SITE_ORIGIN}/blog/${p.slug}/`,
      lastmod: p.published_at
        ? new Date(p.published_at).toISOString().slice(0, 10)
        : null,
    })),
  ];
  const body = entries
    .map(
      (e) =>
        `  <url>\n    <loc>${esc(e.loc)}</loc>` +
        (e.lastmod ? `\n    <lastmod>${e.lastmod}</lastmod>` : '') +
        `\n  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

// robots.txt — allow everything, point crawlers at the sitemap so it
// gets auto-discovered without a manual Search Console submission.
function renderRobots() {
  return `User-agent: *
Allow: /

Sitemap: ${SITE_ORIGIN}/sitemap.xml
`;
}

async function fetchPosts() {
  const url = `${SUPABASE_URL}/rest/v1/blog_posts` +
    `?select=slug,title,meta_description,body_html,sources_html,published_at` +
    `&status=eq.published` +
    `&order=published_at.desc`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase blog_posts fetch ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  console.log('[build] fetching published blog posts…');
  const posts = await fetchPosts();
  console.log(`[build] ${posts.length} published post${posts.length === 1 ? '' : 's'}`);

  // Wipe the directory so deletes/renames in Supabase propagate. The
  // generated dir is gitignored, so we don't lose anything tracked.
  if (existsSync(BLOG_DIR)) {
    await rm(BLOG_DIR, { recursive: true, force: true });
  }
  await mkdir(BLOG_DIR, { recursive: true });

  await writeFile(join(BLOG_DIR, 'index.html'), renderIndex(posts), 'utf8');
  console.log('[build] wrote blog/index.html');

  for (const post of posts) {
    const dir = join(BLOG_DIR, post.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), renderPost(post), 'utf8');
    console.log(`[build] wrote blog/${post.slug}/index.html`);
  }

  // sitemap.xml + robots.txt — written to the site root, regenerated
  // every build so new posts appear in the sitemap automatically.
  await writeFile(join(__dirname, 'sitemap.xml'), renderSitemap(posts), 'utf8');
  await writeFile(join(__dirname, 'robots.txt'), renderRobots(), 'utf8');
  console.log('[build] wrote sitemap.xml + robots.txt');

  console.log('[build] done');
}

main().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});
