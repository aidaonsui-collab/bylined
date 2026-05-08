#!/usr/bin/env tsx
// Generate a brand voice fingerprint from a site's existing pages.
//
// Usage:
//   npm run voice -- <homepage-url>
//
// Output: voices/<hostname>.json — load it later with `gen --voice <path>`.

import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { extractFingerprint } from "./clients/voice.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: npm run voice -- <homepage-url>");
  console.error("Example: npm run voice -- https://yourbrand.com");
  process.exit(1);
}

const homepage = args[0];

(async () => {
  console.log(`Analysing voice from ${homepage}...`);
  console.log(`(this fetches ~5-8 pages and runs one Minimax call — should take 30-60s)\n`);

  try {
    const fp = await extractFingerprint(homepage);
    mkdirSync("voices", { recursive: true });
    const slug = new URL(homepage).hostname.replace(/[^a-z0-9.]+/gi, "-");
    const outPath = join("voices", `${slug}.json`);
    writeFileSync(outPath, JSON.stringify(fp, null, 2));

    console.log(`✓ Voice fingerprint written to ${outPath}\n`);
    console.log(`  Pages analyzed: ${fp.pages_analyzed.length}`);
    console.log(`  Tone: ${fp.tone}`);
    console.log(`  Avg sentence length: ${fp.avg_sentence_length} words`);
    console.log(`  Technical level: ${fp.technical_level}`);
    console.log(`  Signature phrases: ${fp.signature_phrases.slice(0, 4).join(", ")}${
      fp.signature_phrases.length > 4 ? `, +${fp.signature_phrases.length - 4} more` : ""
    }`);
    console.log(`  Taboo: ${fp.taboo.join(", ")}`);
    console.log(`\nUse with: npm run gen -- --voice ${outPath} "<keyword>"`);
  } catch (e) {
    console.error("\n✗ Failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
})();
