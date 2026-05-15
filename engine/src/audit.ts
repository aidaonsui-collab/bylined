// AI-visibility audit — the honest version of the competitor "score."
//
// The real, measurable question: when someone asks an AI the questions
// your customers ask, does your business get recommended? We crawl the
// site, infer the brand + 5 realistic buyer questions, ask an AI each
// question 3× (15 runs), and tally who got named.
//
// No invented "score out of 100." The output is concrete and
// reproducible: "mentioned in N of 15 runs; here's who beat you; here's
// a transcript." That IS the receipt.
//
// Grounding: real-world AI products (ChatGPT, Claude, Perplexity, Google
// AI Overviews) answer commercial-intent queries by searching the web,
// then synthesising over the results. A bare-LLM completion has no idea
// who's actually selling roofing services in Corpus Christi today; it
// confabulates from training-data adjacencies (national insurance
// brands, generic-sounding names, etc.). To match what real customers
// see, we do search-first RAG: query the web, pass real result snippets
// to the LLM, and constrain it to recommend only businesses appearing
// in those snippets.

import { fetchPage } from "./fetcher.js";
import { chatJSON } from "./clients/minimax.js";
import { searchSerp } from "./clients/ddg.js";
import type { SerpResult } from "./types.js";

const RUNS_PER_QUESTION = 3;

export interface AuditQuestionResult {
  question: string;
  runs: number;
  mentions: number; // how many of `runs` named the brand
}

export interface AuditCompetitor {
  name: string;
  count: number; // total times named across all 15 runs
}

export interface AuditResult {
  brand_name: string;
  category: string;
  site_summary: string;
  total_runs: number;
  mention_count: number; // brand mentions across all runs
  questions: AuditQuestionResult[];
  competitors: AuditCompetitor[]; // who showed up instead, most-named first
  // One illustrative exchange for the "receipts" panel.
  transcript_sample: {
    question: string;
    answer: string;
    brand_mentioned: boolean;
  };
}

// ─── Brand / question inference ────────────────────────────────────

interface SiteProfile {
  brand_name: string;
  category: string;
  site_summary: string;
  buyer_questions: string[];
}

const PROFILE_PROMPT = `You analyze a business's homepage and produce the inputs for an "AI visibility" check.

Return JSON in this exact shape:
{
  "brand_name": "<the business's name as customers would say it — e.g. 'PostHog', 'Acme Plumbing'>",
  "category": "<short category — e.g. 'product analytics software', 'plumbing services in Austin'>",
  "site_summary": "<one plain sentence: what this business does>",
  "buyer_questions": [
    "<5 recommendation-seeking questions a potential customer would ask an AI assistant when they DON'T yet know which business/product to pick. The natural answer must be a list of specific BUSINESSES, not advice. Good: 'what are the best product analytics tools for startups', 'who are the top-rated roofing contractors in Corpus Christi TX', 'which plumber should I call for a burst pipe in Austin', 'best Italian restaurants near Soho London'. Bad (informational, not commercial): 'how much does a new roof cost', 'what materials hold up best in hurricanes', 'how long does a tooth extraction take' — these get an explainer, not a vendor list. Do NOT mention the brand name in the questions.>"
  ]
}

Exactly 5 buyer_questions. Each one must be the kind of query whose natural answer is "Here are some businesses/products you should consider: A, B, C." — not an explainer, not a how-to, not a pricing breakdown.`;

// ─── Per-question AI answer ────────────────────────────────────────

interface AnswerResult {
  answer: string;
  companies: string[]; // every company/brand the answer named
}

// Search-grounded answer prompt. The LLM is constrained to recommend
// only businesses that actually appear in the provided search results.
// This mirrors how real LLM products (ChatGPT search, Claude with web
// tools, Perplexity, Google AI Overviews) ground their commercial-intent
// answers in retrieved snippets rather than parametric memory.
const ANSWER_PROMPT = `You are an AI assistant helping someone pick a business. You will be given search results for the user's question. Answer their question by recommending businesses that appear in those search results.

Hard rules:
- Only name businesses that are clearly described in the provided search results. Do NOT invent names or recall companies from your own knowledge — if a business isn't in the search results, you cannot recommend it.
- Prefer specific, real businesses (with a name like "Acme Roofing & Construction") over generic categories.
- 2-4 sentences. Be natural, like you're answering a friend.

Return JSON in this exact shape:
{
  "answer": "<your natural recommendation answer, 2-4 sentences>",
  "companies": ["<every business name you recommended in the answer>"]
}`;

// Build a compact, LLM-readable block from SerpResult[]. Title +
// description is usually enough signal — the model just needs to know
// which businesses actually exist for this query.
function formatSearchContext(results: SerpResult[]): string {
  if (results.length === 0) return "(No search results were returned.)";
  return results
    .slice(0, 8)
    .map((r, i) => {
      const line1 = `[${i + 1}] ${r.title}`;
      const line2 = r.description ? `\n    ${r.description}` : "";
      return line1 + line2;
    })
    .join("\n");
}

// Normalize a name for fuzzy matching: lowercase, strip non-alphanumeric.
function norm(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Does `companies` include the brand? Match if either string contains
// the other once normalized — catches "PostHog" vs "Posthog", "Acme"
// vs "Acme Plumbing", etc. Guard against trivially short stems.
function brandIsNamed(companies: string[], brandStems: string[]): boolean {
  for (const c of companies) {
    const cn = norm(c);
    if (cn.length < 3) continue;
    for (const stem of brandStems) {
      if (stem.length < 3) continue;
      if (cn.includes(stem) || stem.includes(cn)) return true;
    }
  }
  return false;
}

export async function auditSite(
  url: string,
  log: (msg: string) => void = () => {}
): Promise<AuditResult> {
  // 1. Crawl the homepage.
  log("reading the site");
  const page = await fetchPage(url, 15000, { costType: "page_fetch" });
  const text = page.plainText.slice(0, 5000);
  if (text.length < 120) {
    throw new Error(
      "That site didn't return enough text to analyze. Try a different page."
    );
  }
  const hostname = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  })();
  const domainStem = norm(hostname.split(".")[0]);

  // 2. Infer brand + 5 buyer questions.
  log("working out what your customers ask");
  const profile = await chatJSON<SiteProfile>(
    [
      { role: "system", content: PROFILE_PROMPT },
      {
        role: "user",
        content:
          `Homepage of ${hostname}` +
          (page.title ? ` (title: "${page.title}")` : "") +
          `:\n\n${text}\n\nReturn the JSON.`,
      },
    ],
    { max_tokens: 2000, costType: "llm_other" }
  );

  const questions = (profile.buyer_questions ?? [])
    .filter((q) => typeof q === "string" && q.trim().length > 8)
    .slice(0, 5);
  if (questions.length === 0) {
    throw new Error("Could not work out what to ask for this site.");
  }
  const brandStems = [norm(profile.brand_name), domainStem].filter(
    (s) => s.length >= 3
  );

  // 3. Search the web once per question, build a context block. We
  //    re-use the same context across the 3 LLM rounds — only LLM
  //    sampling varies, since search results are deterministic enough
  //    that re-searching just adds cost. If a search fails (DDG rate
  //    limit, etc.), the corresponding question is dropped rather than
  //    falling back to ungrounded completion (which would re-introduce
  //    the hallucination bug).
  log("searching the web for what customers actually find");
  const searchResults = await Promise.all(
    questions.map((q) =>
      searchSerp(q, 8).catch((e: unknown) => {
        log(
          `  search failed for "${q.slice(0, 40)}…": ${
            e instanceof Error ? e.message : String(e)
          }`
        );
        return null;
      })
    )
  );
  const contexts = searchResults.map((r) =>
    r ? formatSearchContext(r) : null
  );
  if (contexts.every((c) => c === null)) {
    throw new Error(
      "Couldn't reach the web to ground the audit. Try again in a minute."
    );
  }

  // 4. Ask each question RUNS_PER_QUESTION times, passing the cached
  //    search context. Run in rounds (one pass over all questions per
  //    round) to cap concurrency on the Minimax plan rather than firing
  //    all 15 at once. Questions whose search failed are skipped.
  const perQuestion: AuditQuestionResult[] = questions.map((q) => ({
    question: q,
    runs: 0,
    mentions: 0,
  }));
  const competitorTally = new Map<string, { name: string; count: number }>();
  let mentionCount = 0;
  let transcriptSample: AuditResult["transcript_sample"] | null = null;

  for (let round = 0; round < RUNS_PER_QUESTION; round++) {
    log(`asking the AI — round ${round + 1} of ${RUNS_PER_QUESTION}`);
    const answers = await Promise.all(
      questions.map((q, i) => {
        const ctx = contexts[i];
        if (!ctx) return Promise.resolve(null);
        return chatJSON<AnswerResult>(
          [
            { role: "system", content: ANSWER_PROMPT },
            {
              role: "user",
              content:
                `Question: ${q}\n\n` +
                `Search results for this question:\n${ctx}\n\n` +
                `Recommend businesses to the user based on these search results. Return the JSON.`,
            },
          ],
          { max_tokens: 2000, costType: "llm_other" }
        ).catch((e: unknown) => {
          log(
            `  answer failed: ${e instanceof Error ? e.message : String(e)}`
          );
          return null;
        });
      })
    );

    answers.forEach((a, i) => {
      if (!a) return;
      const companies = Array.isArray(a.companies) ? a.companies : [];
      const named = brandIsNamed(companies, brandStems);
      perQuestion[i].runs += 1;
      if (named) {
        perQuestion[i].mentions += 1;
        mentionCount += 1;
      }
      // Tally everyone who ISN'T the brand as a competitor.
      for (const c of companies) {
        const cn = norm(c);
        if (cn.length < 3) continue;
        const isBrand = brandStems.some(
          (s) => cn.includes(s) || s.includes(cn)
        );
        if (isBrand) continue;
        const key = cn;
        const existing = competitorTally.get(key);
        if (existing) existing.count += 1;
        else competitorTally.set(key, { name: c.trim(), count: 1 });
      }
      // Keep the first answer as the transcript sample; prefer one
      // where the brand was NOT mentioned (more illustrative of the gap).
      if (!transcriptSample || (transcriptSample.brand_mentioned && !named)) {
        transcriptSample = {
          question: questions[i],
          answer: a.answer ?? "",
          brand_mentioned: named,
        };
      }
    });
  }

  const competitors = [...competitorTally.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const totalRuns = perQuestion.reduce((s, q) => s + q.runs, 0);

  return {
    brand_name: profile.brand_name?.trim() || hostname,
    category: profile.category?.trim() || "",
    site_summary: profile.site_summary?.trim() || "",
    total_runs: totalRuns,
    mention_count: mentionCount,
    questions: perQuestion,
    competitors,
    transcript_sample:
      transcriptSample ?? {
        question: questions[0],
        answer: "",
        brand_mentioned: false,
      },
  };
}
