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
// We query Minimax (the model we run on). The result is honest about
// that — it says "an AI search engine," never claims a model we don't
// actually call.

import { fetchPage } from "./fetcher.js";
import { chatJSON } from "./clients/minimax.js";

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
    "<5 questions a real potential customer would ask an AI assistant when shopping in this category. Natural, specific, commercial-intent. e.g. 'what are the best product analytics tools for startups', 'which plumber should I call for a burst pipe in Austin'. Do NOT mention the brand name in the questions.>"
  ]
}

Exactly 5 buyer_questions. They must be the kind of thing someone types into ChatGPT when they DON'T yet know which company to pick.`;

// ─── Per-question AI answer ────────────────────────────────────────

interface AnswerResult {
  answer: string;
  companies: string[]; // every company/brand the answer named
}

const ANSWER_PROMPT = `You are an AI assistant helping someone choose who to buy from. Answer their question the way you naturally would — recommend specific, real companies, products, or providers you actually know of in this space. Be genuine: name the ones you'd really suggest.

Return JSON in this exact shape:
{
  "answer": "<your natural recommendation answer, 2-4 sentences>",
  "companies": ["<every company / brand / product name you named in the answer>"]
}`;

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

  // 3. Ask each question RUNS_PER_QUESTION times. Run in rounds (one
  //    pass over all questions per round) to cap concurrency on the
  //    Minimax plan rather than firing all 15 at once.
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
      questions.map((q) =>
        chatJSON<AnswerResult>(
          [
            { role: "system", content: ANSWER_PROMPT },
            { role: "user", content: q },
          ],
          { max_tokens: 2000, costType: "llm_other" }
        ).catch((e: unknown) => {
          log(
            `  answer failed: ${e instanceof Error ? e.message : String(e)}`
          );
          return null;
        })
      )
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
