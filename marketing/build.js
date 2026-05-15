#!/usr/bin/env node
// Marketing-site build step.
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
function shell({ title, description, bodyClass = '', content }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="${esc(description)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:type" content="article" />
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
        <a href="/receipts.html">Receipts</a>
        <a href="/pricing.html">Pricing</a>
        <a href="/blog/">Blog</a>
      </div>
      <div class="mkt-nav-cta">
        <a class="btn btn-sm btn-ghost" href="/sign-in">Sign in</a>
        <a class="btn btn-primary btn-sm" href="/sign-up">Start free <svg class="icon icon-sm"><use href="#i-arrow-right"/></svg></a>
      </div>
    </div>
  </nav>

  ${content}

  <footer class="mkt-footer">
    <div class="mkt-container mkt-footer-inner">
      <div class="footer-l">
        <span class="brand-mark"><svg class="icon icon-sm"><use href="#i-logo"/></svg></span>
        <span class="brand-wm">bylined</span>
        <span class="footer-tag">Hands-off SEO that shows its work.</span>
      </div>
      <div class="footer-cols">
        <div>
          <div class="footer-h">Product</div>
          <a href="/receipts.html">Receipts</a>
          <a href="/pricing.html">Pricing</a>
          <a href="/blog/">Blog</a>
        </div>
        <div>
          <div class="footer-h">Legal</div>
          <a href="/privacy.html">Privacy</a>
          <a href="/terms.html">Terms</a>
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

  return shell({
    title: 'Bylined · Blog',
    description: 'Articles generated by Bylined — every claim sourced and verified.',
    bodyClass: 'page-blog',
    content: hero + list,
  });
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

  console.log('[build] done');
}

main().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});
