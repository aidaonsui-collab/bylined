#!/usr/bin/env tsx
// Webflow CLI — discovery + publish.
//
// Webflow has site-specific collection schemas, so first-time setup is a
// 3-step discovery flow:
//   1. npm run webflow -- sites
//        → lists sites the API token has access to
//   2. npm run webflow -- collections <siteId>
//        → lists collections (content types) on that site
//   3. npm run webflow -- inspect <collectionId>
//        → shows the collection's field schema; you confirm the mapping
//
// Then to publish:
//   npm run webflow -- publish <article.json> <collectionId> [--live]

import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  listSites,
  listCollections,
  getCollectionSchema,
  autoDetectMapping,
  createItem,
  publishSite,
  configFromEnv,
  type FieldMapping,
} from "./clients/webflow.js";
import { markdownToHtml, buildSourcesHtml } from "./markdown.js";
import type { Article } from "./types.js";

const args = process.argv.slice(2);
const cmd = args[0];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 70);
}

function usage(): never {
  console.error(`Usage:
  npm run webflow -- sites                      # list sites
  npm run webflow -- collections <siteId>       # list collections
  npm run webflow -- inspect <collectionId>     # show field schema
  npm run webflow -- publish <article.json> <collectionId> [--live]
                                                # publish article (--live also pushes site)`);
  process.exit(1);
}

(async () => {
  if (!cmd) usage();

  const cfg = configFromEnv();

  if (cmd === "sites") {
    const sites = await listSites(cfg);
    console.log(`\n${sites.length} site(s):\n`);
    for (const s of sites) {
      console.log(`  ${s.id}   ${s.displayName}   (${s.shortName}.webflow.io)`);
    }
    return;
  }

  if (cmd === "collections") {
    const siteId = args[1];
    if (!siteId) usage();
    const cols = await listCollections(cfg, siteId);
    console.log(`\n${cols.length} collection(s):\n`);
    for (const c of cols) {
      console.log(`  ${c.id}   ${c.displayName}   (slug: ${c.slug})`);
    }
    return;
  }

  if (cmd === "inspect") {
    const collectionId = args[1];
    if (!collectionId) usage();
    const schema = await getCollectionSchema(cfg, collectionId);
    console.log(`\nCollection: ${schema.displayName} (${schema.id})\n`);
    console.log(`Fields:`);
    for (const f of schema.fields) {
      const required = f.isRequired ? " [required]" : "";
      console.log(`  ${f.slug.padEnd(28)} ${f.type.padEnd(14)} ${f.displayName}${required}`);
    }
    const auto = autoDetectMapping(schema);
    console.log(`\nAuto-detected mapping:`);
    console.log(`  title  →  ${auto.title ?? "(not detected — set manually)"}`);
    console.log(`  slug   →  ${auto.slug ?? "(not detected — set manually)"}`);
    console.log(`  body   →  ${auto.body ?? "(not detected — set manually)"}`);
    console.log(`  excerpt→  ${auto.excerpt ?? "(optional, none detected)"}`);
    if (!auto.title || !auto.slug || !auto.body) {
      console.log(
        `\nNote: not all required mappings auto-detected. You'll need to pass --map ` +
          `flags when publishing, or override autoDetectMapping() for this site.`
      );
    }
    return;
  }

  if (cmd === "publish") {
    const articlePath = args[1];
    const collectionId = args[2];
    if (!articlePath || !collectionId) usage();
    const live = args.includes("--live");

    const article = JSON.parse(readFileSync(articlePath, "utf-8")) as Article;
    const schema = await getCollectionSchema(cfg, collectionId);
    const auto = autoDetectMapping(schema);

    if (!auto.title || !auto.slug || !auto.body) {
      console.error(
        `Could not auto-detect required field mappings for this collection. ` +
          `Run \`npm run webflow -- inspect ${collectionId}\` to see the schema, ` +
          `then either rename your fields to match defaults (name/slug/post-body) ` +
          `or extend autoDetectMapping() in src/clients/webflow.ts.`
      );
      process.exit(1);
    }

    const mapping = auto as FieldMapping;
    const bodyHtml = markdownToHtml(article.body_markdown);
    const sourcesHtml = buildSourcesHtml(article.receipts);
    const fullContent = sourcesHtml ? `${bodyHtml}\n\n${sourcesHtml}` : bodyHtml;

    console.log(`Publishing to Webflow collection ${collectionId} (draft=${!live})...`);
    const result = await createItem(cfg, {
      collectionId,
      mapping,
      values: {
        title: article.title,
        slug: slugify(article.title),
        body: fullContent,
        excerpt: article.meta_description,
      },
      isDraft: !live,
    });
    console.log(`✓ Item created: ${result.id}`);

    if (live) {
      // Need siteId to publish — TODO: derive from collection schema or prompt
      console.log(
        `\nTo make it visible on your live site, run:\n  npm run webflow -- publish-site <siteId>\n` +
          `(or set up Webflow's auto-publish in your CMS settings)`
      );
    } else {
      console.log(`\nItem is staged as a draft. Review in Webflow Designer, then publish.`);
    }
    return;
  }

  if (cmd === "publish-site") {
    const siteId = args[1];
    if (!siteId) usage();
    await publishSite(cfg, siteId);
    console.log(`✓ Site ${siteId} published live.`);
    return;
  }

  usage();
})().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
