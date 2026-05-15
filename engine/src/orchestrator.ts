import { search } from "./search.js";
import { fetchPage, type FetchedPage } from "./fetcher.js";
import { extractFacts } from "./extractor.js";
import { generateArticle } from "./generator.js";
import { verifyClaim, fuzzyMatch, extractAllNumbers } from "./verifier.js";
import { retryCitation } from "./regenerator.js";
import { snapshotMany } from "./clients/wayback.js";
import type { VoiceFingerprint } from "./clients/voice.js";
import type { Article, Fact, Receipt } from "./types.js";

// Pass-rate policy. The marketing copy promises a rolling first-pass
// rate of ≥95% (receipts.html). Per-article we operate two gates:
//   TARGET_PASS_RATE  — try to retry failed citations until we hit this.
//   MIN_PASS_RATE     — final floor. If we can't reach this even after
//                       retries, refuse to ship the article rather than
//                       publish something below our public claim.
// Both are configurable via env so we can tighten/loosen without a
// code change as the rolling rate moves.
const TARGET_PASS_RATE = Number(process.env.BYLINED_TARGET_PASS_RATE ?? 0.95);
const MIN_PASS_RATE = Number(process.env.BYLINED_MIN_PASS_RATE ?? 0.85);

export interface GenerateOptions {
  keyword: string;
  serpCount?: number;
  voice?: VoiceFingerprint;
  log?: (msg: string) => void;
}

export async function generate(opts: GenerateOptions): Promise<Article> {
  const log = opts.log ?? ((msg: string) => console.log(`[bylined] ${msg}`));
  const startedAt = new Date().toISOString();

  // 1. SERP fetch (Brave in production, DDG fallback for local dev)
  log(`searching SERP for: ${opts.keyword}`);
  const serpResults = await search(opts.keyword, opts.serpCount ?? 10);
  log(`SERP returned ${serpResults.length} results`);
  if (serpResults.length === 0) {
    throw new Error(
      "Search returned no results for this keyword — can't build a sourced article."
    );
  }

  // 2. Fetch each page in parallel (failures are logged + skipped)
  log(`fetching ${serpResults.length} pages...`);
  const pages = await Promise.all(
    serpResults.map((r) =>
      fetchPage(r.url).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        log(`fetch failed for ${r.url}: ${msg}`);
        return null;
      })
    )
  );
  const successfulPages = pages.filter((p): p is FetchedPage => p !== null);
  log(`fetched ${successfulPages.length}/${pages.length} pages`);

  // 3. Extract facts from each page
  log(`extracting facts...`);
  const factArrays = await Promise.all(
    successfulPages.map((p) =>
      extractFacts(p).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        log(`extract failed for ${p.url}: ${msg}`);
        return [] as Fact[];
      })
    )
  );
  const allFacts = factArrays.flat();
  log(`extracted ${allFacts.length} facts total`);

  if (allFacts.length === 0) {
    throw new Error("No facts extracted — cannot generate sourced article.");
  }

  const facts = allFacts.slice(0, 50);
  if (facts.length < allFacts.length) {
    log(`capping to top ${facts.length} facts`);
  }

  // 4. Generate article (body is plain prose; citations carry alignment).
  //    If a brand voice fingerprint was passed in, the generator prepends
  //    style guidance to its system prompt.
  if (opts.voice) {
    log(`using brand voice fingerprint from ${opts.voice.source_url}`);
  }
  log(`generating article...`);
  const generated = await generateArticle(opts.keyword, facts, opts.voice);
  log(`generated draft with ${generated.citations.length} candidate citations`);

  // 5. Validate every citation through 5 gates. Only fully-passed citations
  //    earn an inline marker in the rendered body and a receipt in output.
  log(`running validation gates on ${generated.citations.length} citations...`);

  type PassedCitation = {
    claim: string;
    source_url: string;
    exact_passage: string;
    type: "stat" | "quote" | "claim";
    retrieved_at: string;
    pos: number;
    matchLength: number;
  };

  const passed: PassedCitation[] = [];
  const failed: Receipt[] = [];

  // Tracks the original generator citation alongside each failure so the
  // retry pass can re-pick a source for the same claim. We don't expose
  // this in the public Article shape — it's a local-only join key.
  type FailureRecord = {
    cite: (typeof generated.citations)[number];
    receiptIdx: number; // index into `failed` so we can mutate-or-remove
    pos: number;
    matchLength: number;
    gate: 1 | 2 | 3 | 4 | 5;
  };
  const failureRecords: FailureRecord[] = [];

  for (const cite of generated.citations) {
    // Gate 1: locate the claim in body_markdown.
    // Strict exact-substring is ideal; fall back to trailing-30-char suffix
    // match to recover from minor model paraphrasing at the start of the
    // claim (e.g. claim says "email marketing generates $42..." but body
    // says "generating $42..."). The substantive end of the claim, where
    // the [^N] marker actually goes, is almost always verbatim.
    let pos = generated.body_markdown.indexOf(cite.claim);
    let matchLength = cite.claim.length;
    if (pos < 0 && cite.claim.length >= 30) {
      const suffix = cite.claim.slice(-30);
      const suffixPos = generated.body_markdown.indexOf(suffix);
      if (suffixPos >= 0) {
        pos = suffixPos;
        matchLength = suffix.length;
      }
    }
    if (pos < 0) {
      failureRecords.push({
        cite,
        receiptIdx: failed.length,
        pos: -1,
        matchLength: 0,
        gate: 1,
      });
      failed.push({
        id: 0,
        source_url: "",
        passage: cite.claim,
        type: "claim",
        retrieved_at: startedAt,
        verified: false,
        verification_notes: `claim_not_in_body: claim is not a substring of body_markdown (even fuzzy suffix match failed).`,
      });
      continue;
    }

    // Gate 2: source_id must resolve to a fact in our library
    const sourceIdx = parseInt(cite.source_id.replace(/^f/, ""), 10) - 1;
    const fact = Number.isFinite(sourceIdx) ? facts[sourceIdx] : undefined;
    if (!fact) {
      failureRecords.push({ cite, receiptIdx: failed.length, pos, matchLength, gate: 2 });
      failed.push({
        id: 0,
        source_url: "",
        passage: cite.claim,
        type: "claim",
        retrieved_at: startedAt,
        verified: false,
        verification_notes: `model_synthesized: source_id "${cite.source_id}" not in library.`,
      });
      continue;
    }

    // Gate 3: exact_quote_used must be a fuzzy substring of fact.exact_passage
    if (!fuzzyMatch(fact.exact_passage, cite.exact_quote_used)) {
      failureRecords.push({ cite, receiptIdx: failed.length, pos, matchLength, gate: 3 });
      failed.push({
        id: 0,
        source_url: fact.source_url,
        passage: cite.exact_quote_used,
        type: fact.type,
        retrieved_at: fact.retrieved_at,
        verified: false,
        verification_notes: `model_synthesized: exact_quote_used is not a verbatim substring of the cited fact.`,
      });
      continue;
    }

    // Gate 4 (NEW): alignment — numbers in claim must appear in exact_quote_used.
    // This catches decorative citations where the cited fact has nothing to do
    // with what's actually being said in the body.
    const claimNumbers = extractAllNumbers(cite.claim);
    if (claimNumbers.length > 0) {
      const quoteNumbers = new Set(extractAllNumbers(cite.exact_quote_used));
      const missing = claimNumbers.filter((n) => !quoteNumbers.has(n));
      if (missing.length > 0) {
        failureRecords.push({ cite, receiptIdx: failed.length, pos, matchLength, gate: 4 });
        failed.push({
          id: 0,
          source_url: fact.source_url,
          passage: cite.claim,
          type: fact.type,
          retrieved_at: fact.retrieved_at,
          verified: false,
          verification_notes: `alignment_mismatch: claim numbers [${claimNumbers.join(",")}] not all present in cited quote. Missing: [${missing.join(",")}]. The citation does not support the claim.`,
        });
        continue;
      }
    }

    // Gate 5: URL-fetch verification — does the quote still appear at the
    // source URL right now, with the expected number?
    const result = await verifyClaim({
      url: fact.source_url,
      exact_quote_used: cite.exact_quote_used,
      expected_number: fact.number,
    });

    if (!result.passed) {
      failureRecords.push({ cite, receiptIdx: failed.length, pos, matchLength, gate: 5 });
      failed.push({
        id: 0,
        source_url: fact.source_url,
        passage: cite.exact_quote_used,
        type: fact.type,
        retrieved_at: fact.retrieved_at,
        verified: false,
        verification_notes: `${result.reason}: ${result.detail}`,
      });
      continue;
    }

    // All gates passed.
    passed.push({
      claim: cite.claim,
      source_url: fact.source_url,
      exact_passage: fact.exact_passage,
      type: fact.type,
      retrieved_at: fact.retrieved_at,
      pos,
      matchLength,
    });
  }

  const totalCitations = generated.citations.length;
  const firstPassRate = totalCitations > 0 ? passed.length / totalCitations : 0;
  log(`validation (first pass): ${passed.length}/${totalCitations} passed (${(
    firstPassRate * 100
  ).toFixed(1)}%)`);

  // 5b. Re-verification loop. Marketing promises a ≥95% first-pass +
  //     re-verification rate; this is where the re-verification happens.
  //     For each gate-2-through-5 failure, we ask the LLM to pick a
  //     DIFFERENT supporting fact for the same claim (or admit nothing
  //     supports it). Newly-picked citations re-enter the same 5 gates;
  //     survivors get promoted into passed[] and their failure receipt
  //     gets removed. Gate-1 failures (claim not in body) aren't
  //     retried — there's nothing to anchor a citation to.
  const retryable = failureRecords.filter((r) => r.gate !== 1);
  if (firstPassRate < TARGET_PASS_RATE && retryable.length > 0) {
    log(
      `attempting re-verification on ${retryable.length} failed citations ` +
        `(target ${(TARGET_PASS_RATE * 100).toFixed(0)}%)`
    );
    const recoveredReceiptIdxs = new Set<number>();
    for (const f of retryable) {
      const retry = await retryCitation(f.cite.claim, facts);
      if (!retry || !retry.source_id || !retry.exact_quote_used) continue;

      const sourceIdx = parseInt(retry.source_id.replace(/^f/, ""), 10) - 1;
      const newFact = Number.isFinite(sourceIdx) ? facts[sourceIdx] : undefined;
      if (!newFact) continue;

      // Re-run gates 3 → 5 on the new citation. Gate 1 already passed
      // (we have pos/matchLength). Gate 2 also passes since we just
      // resolved the source_id ourselves.
      if (!fuzzyMatch(newFact.exact_passage, retry.exact_quote_used)) continue;

      const claimNumbers = extractAllNumbers(f.cite.claim);
      if (claimNumbers.length > 0) {
        const quoteNumbers = new Set(extractAllNumbers(retry.exact_quote_used));
        if (claimNumbers.some((n) => !quoteNumbers.has(n))) continue;
      }

      const urlCheck = await verifyClaim({
        url: newFact.source_url,
        exact_quote_used: retry.exact_quote_used,
        expected_number: newFact.number,
      });
      if (!urlCheck.passed) continue;

      // Survived all gates — promote.
      passed.push({
        claim: f.cite.claim,
        source_url: newFact.source_url,
        exact_passage: newFact.exact_passage,
        type: newFact.type,
        retrieved_at: newFact.retrieved_at,
        pos: f.pos,
        matchLength: f.matchLength,
      });
      recoveredReceiptIdxs.add(f.receiptIdx);
    }
    // Drop the recovered entries from failed[] in one pass — easier than
    // mutating indices mid-loop.
    if (recoveredReceiptIdxs.size > 0) {
      for (let i = failed.length - 1; i >= 0; i--) {
        if (recoveredReceiptIdxs.has(i)) failed.splice(i, 1);
      }
      log(
        `re-verification recovered ${recoveredReceiptIdxs.size} citations — ` +
          `${passed.length}/${totalCitations} now passing (` +
          `${((passed.length / totalCitations) * 100).toFixed(1)}%)`
      );
    } else {
      log(`re-verification recovered 0 citations`);
    }
  }

  // 5c. Final gate. Refuse to ship articles whose verification rate is
  //     below MIN_PASS_RATE — the public claim is that we don't publish
  //     low-pass-rate articles. Better to fail the job and force a
  //     re-run than to ship something below the promised bar.
  const finalPassRate =
    totalCitations > 0 ? passed.length / totalCitations : 0;
  if (totalCitations > 0 && finalPassRate < MIN_PASS_RATE) {
    throw new Error(
      `Only ${(finalPassRate * 100).toFixed(0)}% of claims could be verified ` +
        `(our floor is ${(MIN_PASS_RATE * 100).toFixed(0)}%) — we won't ship an ` +
        `article we can't stand behind. Try a different keyword or check that ` +
        `the source pages are reachable.`
    );
  }

  // 6. Sort passed citations by position in body and assign sequential IDs.
  //    Then walk in REVERSE order so insertions don't shift earlier positions.
  const positioned = passed.slice().sort((a, b) => a.pos - b.pos);
  const seqIds = new Map<PassedCitation, number>();
  positioned.forEach((c, i) => seqIds.set(c, i + 1));

  let body = generated.body_markdown;
  for (let i = positioned.length - 1; i >= 0; i--) {
    const c = positioned[i];
    const id = seqIds.get(c)!;
    // Insert at the END of the matched region (whether full claim or suffix).
    const insertAt = c.pos + c.matchLength;
    body = body.slice(0, insertAt) + `[^${id}]` + body.slice(insertAt);
  }

  // 7. Trigger Wayback snapshots for every verified source URL (deduped,
  //    fire-and-forget). Then build receipts in source-position order.
  const snaps = snapshotMany(positioned.map((c) => c.source_url));
  log(`triggered ${snaps.size} Wayback snapshots (fire-and-forget)`);

  const verifiedReceipts: Receipt[] = positioned.map((c) => {
    const snap = snaps.get(c.source_url);
    return {
      id: seqIds.get(c)!,
      source_url: c.source_url,
      passage: c.exact_passage,
      type: c.type,
      retrieved_at: c.retrieved_at,
      verified: true,
      wayback_url: snap?.wayback_url,
      archived_at: snap?.archived_at,
    };
  });

  // 8. Append failed citations to receipts for transparency, with IDs after
  //    the verified ones so the body markers stay clean.
  let nextId = positioned.length + 1;
  const failedWithIds = failed.map((r) => ({ ...r, id: nextId++ }));

  const passRate =
    generated.citations.length > 0
      ? passed.length / generated.citations.length
      : 0;

  return {
    title: generated.title,
    meta_description: generated.meta_description,
    body_markdown: body,
    receipts: [...verifiedReceipts, ...failedWithIds],
    pass_rate: passRate,
    generated_at: startedAt,
  };
}
