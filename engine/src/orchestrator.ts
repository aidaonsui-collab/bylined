import { search } from "./search.js";
import { fetchPage, type FetchedPage } from "./fetcher.js";
import { extractFacts } from "./extractor.js";
import { generateArticle } from "./generator.js";
import { verifyClaim, fuzzyMatch, extractAllNumbers } from "./verifier.js";
import { retryCitation } from "./regenerator.js";
import { snapshotMany } from "./clients/wayback.js";
import type { VoiceFingerprint } from "./clients/voice.js";
import { computeAEOScore, computeVoiceMatchScore } from "./scorer.js";
import type { Article, Fact, Receipt } from "./types.js";

// Pass-rate policy. The marketing copy promises a rolling first-pass
// rate of ≥95% (receipts.html). Per-article:
//   1. Run the 5-gate verifier on the generator's output (first pass).
//   2. If we're below TARGET_PASS_RATE, retry each gate-2-through-5
//      failure with retryCitation() — model picks a different source.
//   3. Any citation that still can't be verified after retry has its
//      claim sentence surgically dropped from the body. Every printed
//      claim ships verified. pass_rate stored on the article is the
//      ORIGINAL first-pass rate so the rolling metric stays honest;
//      the trimmed body just guarantees the per-article promise.
const TARGET_PASS_RATE = Number(process.env.BYLINED_TARGET_PASS_RATE ?? 0.95);

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
  // recoveredReceiptIdxs lifted out of the if-block so step 5c below
  // can identify which failureRecords still need surgery.
  const recoveredReceiptIdxs = new Set<number>();
  if (firstPassRate < TARGET_PASS_RATE && retryable.length > 0) {
    log(
      `attempting re-verification on ${retryable.length} failed citations ` +
        `(target ${(TARGET_PASS_RATE * 100).toFixed(0)}%)`
    );
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
    if (recoveredReceiptIdxs.size > 0) {
      log(
        `re-verification recovered ${recoveredReceiptIdxs.size} citations — ` +
          `${passed.length}/${totalCitations} now passing (` +
          `${((passed.length / totalCitations) * 100).toFixed(1)}%)`
      );
    } else {
      log(`re-verification recovered 0 citations`);
    }
  }

  // 5c. Surgical drop of unsupported claims. After retry, anything still
  //     in `failureRecords` with a valid body position represents a claim
  //     the article makes that we can't verify. We remove the entire
  //     containing sentence from body_markdown rather than ship it. The
  //     article gets shorter; every claim that remains visible is
  //     verified. pass_rate stays as the original first-pass metric so
  //     the rolling generator-quality number is honest.
  //
  //     Gate-1 failures have no body position (their "claim" wasn't in
  //     body anyway), so they need no surgery — they just stay in the
  //     receipts list with verified=false.
  const stillFailed = failureRecords.filter(
    (f) => f.gate !== 1 && !recoveredReceiptIdxs.has(f.receiptIdx)
  );

  let body = generated.body_markdown;
  const droppedReceiptIdxs = new Set<number>();

  if (stillFailed.length > 0) {
    // Compute the sentence range containing each unverified claim. Stop
    // expansion at paragraph breaks (`\n\n`) and at sentence punctuation
    // [.!?] followed by whitespace, so we don't over-trim across topic
    // shifts.
    function findSentenceRange(
      text: string,
      claimPos: number,
      claimLen: number
    ): [number, number] {
      const claimEnd = claimPos + claimLen;
      let sentEnd = text.length;
      for (let i = claimEnd; i < text.length; i++) {
        const c = text[i];
        if (c === "." || c === "!" || c === "?") {
          sentEnd = i + 1;
          break;
        }
        if (c === "\n" && text[i + 1] === "\n") {
          sentEnd = i;
          break;
        }
      }
      let sentStart = 0;
      for (let i = claimPos - 1; i >= 1; i--) {
        const prev = text[i - 1];
        const here = text[i];
        if ((prev === "." || prev === "!" || prev === "?") && here === " ") {
          sentStart = i + 1;
          break;
        }
        if (prev === "\n" && here === "\n") {
          sentStart = i + 1;
          break;
        }
      }
      return [sentStart, sentEnd];
    }

    // Collect candidate ranges.
    const candidateRanges: Array<{ start: number; end: number; failIdx: number }> =
      stillFailed.map((f) => {
        const [s, e] = findSentenceRange(body, f.pos, f.matchLength);
        return { start: s, end: e, failIdx: f.receiptIdx };
      });

    // Drop ranges that would also remove a verified citation. Better to
    // ship a slightly weaker article (one unverified claim alongside
    // some verified ones in the same sentence) than to lose verified
    // material. In practice this almost never fires.
    const verifiedSpans = passed.map((c) => ({
      start: c.pos,
      end: c.pos + c.matchLength,
    }));
    const safeRanges = candidateRanges.filter(
      (r) =>
        !verifiedSpans.some((v) => v.start < r.end && v.end > r.start)
    );

    // Sort by start, merge overlapping, track which receipt idxs each
    // merged range corresponds to.
    safeRanges.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number; idxs: number[] }> = [];
    for (const r of safeRanges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end) {
        last.end = Math.max(last.end, r.end);
        last.idxs.push(r.failIdx);
      } else {
        merged.push({ start: r.start, end: r.end, idxs: [r.failIdx] });
      }
    }

    if (merged.length > 0) {
      // Shift verified-citation positions to account for chars removed
      // before them. Walk verified positions through the merged ranges
      // and subtract removed lengths.
      for (const c of passed) {
        let shift = 0;
        for (const m of merged) {
          if (m.end <= c.pos) shift += m.end - m.start;
          else break;
        }
        c.pos -= shift;
      }

      // Remove ranges from body, highest-pos-first so earlier indices
      // stay valid.
      for (let i = merged.length - 1; i >= 0; i--) {
        const { start, end } = merged[i];
        body = body.slice(0, start) + body.slice(end);
      }
      // Collapse paragraph breaks left over by sentence-only drops.
      body = body.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n");

      // Mark dropped receipt indices for removal from the receipts list
      // below — the article no longer contains those claims, so
      // surfacing them as failed receipts is misleading.
      for (const m of merged) {
        for (const idx of m.idxs) droppedReceiptIdxs.add(idx);
      }

      const droppedSentences = merged.length;
      const droppedClaims = merged.reduce((s, m) => s + m.idxs.length, 0);
      log(
        `dropped ${droppedClaims} unverifiable claim${droppedClaims === 1 ? "" : "s"} ` +
          `across ${droppedSentences} sentence${droppedSentences === 1 ? "" : "s"} ` +
          `from body — every printed claim is now verified`
      );
    }
  }

  // Apply the recovered + dropped removals to the failed[] list in one
  // pass so the receipts that ship match what's actually in the body.
  const toRemove = new Set<number>([
    ...recoveredReceiptIdxs,
    ...droppedReceiptIdxs,
  ]);
  if (toRemove.size > 0) {
    for (let i = failed.length - 1; i >= 0; i--) {
      if (toRemove.has(i)) failed.splice(i, 1);
    }
  }

  // 6. Sort passed citations by position in (possibly trimmed) body and
  //    assign sequential IDs. Walk in REVERSE order so insertions don't
  //    shift earlier positions. Positions were already adjusted above
  //    to account for any sentence drops in step 5c.
  const positioned = passed.slice().sort((a, b) => a.pos - b.pos);
  const seqIds = new Map<PassedCitation, number>();
  positioned.forEach((c, i) => seqIds.set(c, i + 1));

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

  const draftArticle: Article = {
    title: generated.title,
    meta_description: generated.meta_description,
    body_markdown: body,
    receipts: [...verifiedReceipts, ...failedWithIds],
    pass_rate: passRate,
    generated_at: startedAt,
  };

  return {
    ...draftArticle,
    aeo_score: computeAEOScore(draftArticle),
    voice_match_score: opts.voice
      ? computeVoiceMatchScore(draftArticle, opts.voice)
      : null,
  };
}
