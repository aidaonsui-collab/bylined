#!/usr/bin/env tsx
// Run the verification gate against an already-generated article JSON.
// Useful for iterating on verifier logic without burning a full pipeline run.
//
// Usage: npm run verify -- <path-to-article.json>

import "dotenv/config";
import { readFileSync } from "node:fs";
import { verifyClaim } from "./verifier.js";
import type { Article } from "./types.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: npm run verify -- <path-to-article.json>");
  console.error("Example: npm run verify -- fixtures/sample-article.json");
  process.exit(1);
}

const path = args[0];
let article: Article;
try {
  article = JSON.parse(readFileSync(path, "utf-8")) as Article;
} catch (e) {
  console.error(`Failed to read ${path}:`, e instanceof Error ? e.message : e);
  process.exit(1);
}

(async () => {
  let passed = 0;
  console.log(`\nVerifying ${article.receipts.length} receipts from ${path}\n`);

  for (const r of article.receipts) {
    if (!r.source_url) {
      console.log(`✗ [${r.id}] (no source_url) — skipped`);
      continue;
    }
    const result = await verifyClaim({
      url: r.source_url,
      exact_quote_used: r.passage,
    });
    if (result.passed) {
      passed++;
      console.log(`✓ [${r.id}] ${r.source_url}`);
    } else {
      console.log(`✗ [${r.id}] ${r.source_url}`);
      console.log(`     ${result.reason}: ${result.detail}`);
    }
  }

  const rate = article.receipts.length > 0 ? (passed / article.receipts.length) * 100 : 0;
  console.log(`\n${passed}/${article.receipts.length} passed (${rate.toFixed(1)}%)`);
})();
