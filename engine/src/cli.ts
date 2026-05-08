#!/usr/bin/env tsx
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { generate } from "./orchestrator.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: npm run gen -- <keyword>");
  console.error('Example: npm run gen -- "best email marketing platforms for shopify stores 2026"');
  process.exit(1);
}

const keyword = args.join(" ");

(async () => {
  try {
    const article = await generate({ keyword });

    mkdirSync("out", { recursive: true });
    const slug = keyword
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60);
    const filename = `${new Date().toISOString().slice(0, 10)}-${slug}.json`;
    const outPath = join("out", filename);
    writeFileSync(outPath, JSON.stringify(article, null, 2));

    console.log(`\n✓ Article written to ${outPath}`);
    console.log(`  Title: ${article.title}`);
    console.log(`  Body: ${article.body_markdown.length} chars`);
    console.log(
      `  Receipts: ${article.receipts.length} (${
        article.receipts.filter((r) => r.verified).length
      } verified)`
    );
    console.log(`  Pass rate: ${(article.pass_rate * 100).toFixed(1)}%`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("\n✗ Generation failed:", msg);
    process.exit(1);
  }
})();
