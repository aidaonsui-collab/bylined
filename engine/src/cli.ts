#!/usr/bin/env tsx
import "dotenv/config";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "./orchestrator.js";
import type { VoiceFingerprint } from "./clients/voice.js";
import { startRun } from "./cost.js";

const rawArgs = process.argv.slice(2);
const voiceIdx = rawArgs.indexOf("--voice");
let voice: VoiceFingerprint | undefined;
let args = rawArgs;
if (voiceIdx >= 0) {
  const voicePath = rawArgs[voiceIdx + 1];
  if (!voicePath) {
    console.error("--voice flag needs a path argument");
    process.exit(1);
  }
  try {
    voice = JSON.parse(readFileSync(voicePath, "utf-8")) as VoiceFingerprint;
  } catch (e) {
    console.error(`Failed to load voice fingerprint at ${voicePath}: ${
      e instanceof Error ? e.message : e
    }`);
    process.exit(1);
  }
  args = rawArgs.filter((_, i) => i !== voiceIdx && i !== voiceIdx + 1);
}

if (args.length === 0) {
  console.error("Usage: npm run gen -- [--voice <path>] <keyword>");
  console.error('Example: npm run gen -- "best email marketing platforms for shopify stores 2026"');
  console.error('         npm run gen -- --voice voices/myblog.com.json "saas churn"');
  process.exit(1);
}

const keyword = args.join(" ");

(async () => {
  try {
    const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
    const runId = startRun(slug);
    console.log(`[bylined] cost log: out/costs/${runId}.jsonl`);

    const article = await generate({ keyword, voice });

    mkdirSync("out", { recursive: true });
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
