#!/usr/bin/env tsx
// Publish a saved Bylined article to WordPress.
//
// Usage:
//   npm run publish -- <article.json>           # publishes as draft
//   npm run publish -- <article.json> --live    # publishes as "publish"
//   npm run publish -- <article.json> --dry-run # prints HTML, hits no API
//
// Always defaults to draft so you can review in WP admin before going live.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPost, configFromEnv } from "./clients/wordpress.js";
import { markdownToHtml, buildSourcesHtml } from "./markdown.js";
import type { Article } from "./types.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const live = args.includes("--live");
const positional = args.filter((a) => !a.startsWith("--"));

if (positional.length === 0) {
  console.error("Usage: npm run publish -- <article.json> [--live] [--dry-run]");
  console.error("Example: npm run publish -- out/2026-05-08-best-crm.json --dry-run");
  process.exit(1);
}

const articlePath = positional[0];

let article: Article;
try {
  article = JSON.parse(readFileSync(articlePath, "utf-8")) as Article;
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`Failed to read ${articlePath}: ${msg}`);
  process.exit(1);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 70);
}

(async () => {
  const bodyHtml = markdownToHtml(article.body_markdown);
  const sourcesHtml = buildSourcesHtml(article.receipts);
  const fullContent = sourcesHtml ? `${bodyHtml}\n\n${sourcesHtml}` : bodyHtml;
  const slug = slugify(article.title);
  const status = live ? "publish" : "draft";

  if (dryRun) {
    console.log("=== DRY RUN — no API call will be made ===\n");
    console.log("Title:", article.title);
    console.log("Slug:", slug);
    console.log("Status:", status);
    console.log("Excerpt:", article.meta_description);
    console.log(`\nContent (${fullContent.length} chars total, first 800 shown):`);
    console.log("─".repeat(60));
    console.log(fullContent.slice(0, 800));
    if (fullContent.length > 800) console.log("\n... [truncated]");
    console.log("─".repeat(60));
    console.log(`\nReceipts that will appear in Sources section: ${
      article.receipts.filter((r) => r.verified).length
    }`);
    return;
  }

  let cfg;
  try {
    cfg = configFromEnv();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    console.error("\nTip: run with --dry-run to preview without credentials.");
    process.exit(1);
  }

  console.log(`Publishing to ${cfg.baseUrl} as ${status}...`);

  try {
    const result = await createPost(cfg, {
      title: article.title,
      content: fullContent,
      excerpt: article.meta_description,
      slug,
      status,
    });
    console.log(`\n✓ ${live ? "Published" : "Draft created"}.`);
    console.log(`  Post ID:  ${result.id}`);
    console.log(`  Status:   ${result.status}`);
    console.log(`  URL:      ${result.url}`);
    console.log(`  Edit:     ${result.edit_url}`);
    if (!live) {
      console.log(`\nReview in WP admin, then run with --live to publish, or publish from the WP UI.`);
    }
  } catch (e) {
    console.error("\n✗ Publish failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
})();
