// Smoke-test the audit. Invoke: `npx tsx src/audit-cli.ts <url>`
// Prints brand inference, per-question hit rates, and the competitor
// tally to stdout. Doesn't write anywhere — just for manually verifying
// the audit isn't returning hallucinated competitors.

import "dotenv/config";
import { auditSite } from "./audit.js";

const url = process.argv[2];
if (!url) {
  console.error("Usage: npx tsx src/audit-cli.ts <url>");
  process.exit(1);
}

const result = await auditSite(url, (msg) => console.log(`· ${msg}`));

console.log("");
console.log(`Brand:     ${result.brand_name}`);
console.log(`Category:  ${result.category}`);
console.log(`Summary:   ${result.site_summary}`);
console.log(
  `Visibility: ${result.mention_count} of ${result.total_runs} runs named you`
);

console.log("\nPer-question:");
for (const q of result.questions) {
  console.log(
    `  ${q.mentions}/${q.runs}  ${q.question.slice(0, 70)}${
      q.question.length > 70 ? "…" : ""
    }`
  );
}

console.log("\nTop competitors named instead:");
for (const c of result.competitors.slice(0, 10)) {
  console.log(`  ×${c.count}  ${c.name}`);
}

console.log("\nTranscript sample:");
console.log(`  Q: ${result.transcript_sample.question}`);
console.log(`  A: ${result.transcript_sample.answer}`);
console.log(`  Brand mentioned: ${result.transcript_sample.brand_mentioned}`);
