// Head-to-head generation comparison.
//
// Same keyword, same facts library, generate twice — once with MiniMax
// (production default), once with OpenAI — and write both outputs to
// markdown files we can audit side by side.
//
// Usage:
//   npm run compare -- "<keyword>"
//
// Facts are cached to out/compare-<slug>/facts.json after the first
// run, so re-running on the same keyword only burns the two generation
// calls (~$0.15-0.30 instead of ~$0.50). Delete the facts.json to
// force a fresh extraction.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { search } from "./search.js";
import { fetchPage, type FetchedPage } from "./fetcher.js";
import { extractFacts } from "./extractor.js";
import { generateArticle, type GenerationOutput } from "./generator.js";
import { chatJSON as openaiChatJSON } from "./clients/openai.js";
import type { Fact } from "./types.js";

const keyword = process.argv.slice(2).join(" ").trim();
if (!keyword) {
  console.error('usage: npm run compare -- "<keyword>"');
  process.exit(1);
}

const slug = keyword
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 80);
const outDir = path.resolve("out", `compare-${slug}`);
fs.mkdirSync(outDir, { recursive: true });
const factsCachePath = path.join(outDir, "facts.json");

function log(msg: string) {
  console.log(`[compare] ${msg}`);
}

async function getFacts(): Promise<Fact[]> {
  if (fs.existsSync(factsCachePath)) {
    log(`using cached facts from ${factsCachePath}`);
    return JSON.parse(fs.readFileSync(factsCachePath, "utf8")) as Fact[];
  }
  log(`searching SERP for: ${keyword}`);
  const serp = await search(keyword, 10);
  log(`SERP returned ${serp.length} results — fetching pages...`);
  const pages = await Promise.all(
    serp.map((r) =>
      fetchPage(r.url).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        log(`fetch failed for ${r.url}: ${msg}`);
        return null;
      })
    )
  );
  const successful = pages.filter((p): p is FetchedPage => p !== null);
  log(`fetched ${successful.length}/${pages.length} pages — extracting facts...`);
  const factArrays = await Promise.all(
    successful.map((p) =>
      extractFacts(p, keyword).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        log(`extract failed for ${p.url}: ${msg}`);
        return [] as Fact[];
      })
    )
  );
  const facts = factArrays.flat().slice(0, 50);
  fs.writeFileSync(factsCachePath, JSON.stringify(facts, null, 2));
  log(`extracted ${facts.length} facts (cached for re-runs)`);
  return facts;
}

// Insert [^N] markers at the end of each citation's claim, append a
// numbered Sources list. Mirrors orchestrator.ts's render step minus
// the verification gates — we want raw generation output, defects and
// all, so the audit reflects what the model actually produced.
function render(out: GenerationOutput, facts: Fact[]): string {
  type Marker = { pos: number; sourceIdx: number };
  const markers: Marker[] = [];

  for (const cite of out.citations) {
    const pos = out.body_markdown.indexOf(cite.claim);
    if (pos < 0) continue; // claim not in body — skip silently
    const sourceIdx = parseInt(cite.source_id.replace(/^f/, ""), 10) - 1;
    if (!Number.isFinite(sourceIdx) || !facts[sourceIdx]) continue;
    markers.push({ pos: pos + cite.claim.length, sourceIdx });
  }

  markers.sort((a, b) => a.pos - b.pos);

  // Insert markers from end backwards so earlier positions stay valid.
  let body = out.body_markdown;
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    const id = i + 1;
    body = body.slice(0, m.pos) + `[^${id}]` + body.slice(m.pos);
  }

  // Sources list — one entry per marker, in reading order.
  const sources = markers
    .map((m, i) => {
      const f = facts[m.sourceIdx];
      const passage = f.exact_passage.replace(/\s+/g, " ").trim();
      return `${i + 1}. "${passage}" — ${f.source_url}`;
    })
    .join("\n");

  return [
    `# ${out.title}`,
    "",
    `> ${out.meta_description}`,
    "",
    body,
    "",
    "---",
    "",
    "## Sources",
    "",
    sources || "_(no resolved citations — every claim failed to map to a fact)_",
    "",
  ].join("\n");
}

async function main() {
  const facts = await getFacts();
  if (facts.length === 0) {
    console.error("[compare] no facts extracted — can't generate.");
    process.exit(1);
  }

  // Skip MiniMax if we already have a cached result — saves another
  // 2-minute generation when iterating on the OpenAI side. Delete
  // minimax.json (or both .json + .md) to force a fresh run.
  const minimaxJsonPath = path.join(outDir, "minimax.json");
  let minimaxOut: GenerationOutput;
  if (fs.existsSync(minimaxJsonPath)) {
    log(`using cached MiniMax output from ${minimaxJsonPath}`);
    minimaxOut = JSON.parse(
      fs.readFileSync(minimaxJsonPath, "utf8")
    ) as GenerationOutput;
  } else {
    log(`generating with MiniMax (${process.env.MINIMAX_MODEL ?? "MiniMax-M2.7"})...`);
    const tMini = Date.now();
    minimaxOut = await generateArticle(keyword, facts);
    log(
      `MiniMax done in ${((Date.now() - tMini) / 1000).toFixed(1)}s — ` +
        `${minimaxOut.citations.length} citations`
    );
    fs.writeFileSync(minimaxJsonPath, JSON.stringify(minimaxOut, null, 2));
    fs.writeFileSync(path.join(outDir, "minimax.md"), render(minimaxOut, facts));
  }

  log(`generating with OpenAI (${process.env.OPENAI_GENERATION_MODEL ?? "gpt-5"})...`);
  const tGpt = Date.now();
  const openaiOut = await generateArticle(keyword, facts, undefined, openaiChatJSON);
  log(
    `OpenAI done in ${((Date.now() - tGpt) / 1000).toFixed(1)}s — ` +
      `${openaiOut.citations.length} citations`
  );
  fs.writeFileSync(
    path.join(outDir, "openai.json"),
    JSON.stringify(openaiOut, null, 2)
  );
  fs.writeFileSync(path.join(outDir, "openai.md"), render(openaiOut, facts));

  console.log("");
  console.log("[compare] wrote:");
  console.log(`  ${path.join(outDir, "minimax.md")}`);
  console.log(`  ${path.join(outDir, "openai.md")}`);
  console.log("");
  console.log("[compare] paste both back for the head-to-head audit.");
}

main().catch((e) => {
  console.error("[compare] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
