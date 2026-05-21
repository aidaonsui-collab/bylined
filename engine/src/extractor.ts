import { chatJSON } from "./clients/minimax.js";
import { fuzzyMatch } from "./verifier.js";
import type { Fact } from "./types.js";
import type { FetchedPage } from "./fetcher.js";

const SYSTEM_PROMPT = `You extract verifiable facts from a web page that are RELEVANT to a specific article topic. Output JSON only.

You are given an ARTICLE TOPIC (and sometimes its intended audience). Extract only facts that would genuinely help someone reading an article on that topic. A fact can be accurate, verifiable, well-sourced — and still irrelevant. If it does not serve the article topic, SKIP IT.

For each fact you keep, include:
- type: "stat" (numeric or percentage), "quote" (named-source quotation), or "claim" (factual statement)
- exact_passage: the exact sentence containing the fact, copied VERBATIM from the page
- number: for type=stat, the numeric value as it appears (e.g., "41.3%", "$5M", "412")

Rules:
- RELEVANCE FIRST. Before keeping a fact, ask: does this directly help a reader of an article on the given TOPIC? If not, skip it — even if it is a great, well-sourced fact. Example: for a topic about practical salon vocabulary, the etymology of a color word, or an unrelated idiom, is OFF-TOPIC — skip it.
- DO NOT paraphrase. Copy passages verbatim, exactly as they appear in the source.
- exact_passage MUST be a contiguous substring of the page text. If you cannot find a verbatim sentence, skip the fact.
- Only extract facts that are concrete and citation-worthy.
- If a sentence contains a stat AND a quote, extract them as separate facts.
- Return at most 8 facts per page (most relevant first).
- Return [] if the page has no facts relevant to the topic. An entire page can be off-topic — [] is the correct, expected answer in that case, not a failure.`;

interface RawFact {
  type: "stat" | "quote" | "claim";
  exact_passage: string;
  number?: string;
}

export async function extractFacts(
  page: FetchedPage,
  keyword: string,
  audienceContext?: string,
): Promise<Fact[]> {
  const text = page.plainText.slice(0, 12000);
  if (text.length < 200) return [];

  const raw = await chatJSON<RawFact[] | { facts: RawFact[] }>(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `ARTICLE TOPIC: ${keyword}\n` +
          (audienceContext ? `INTENDED AUDIENCE: ${audienceContext}\n` : "") +
          `\nURL: ${page.url}\n\nPage text:\n${text}\n\n` +
          `Extract the facts from this page that are RELEVANT to the article topic, as a JSON array. If nothing on the page is relevant, return [].`,
      },
    ],
    { costType: "llm_extraction" }
  );

  const arr = Array.isArray(raw) ? raw : raw.facts;
  if (!Array.isArray(arr)) return [];

  const wellFormed = arr.filter(
    (f): f is RawFact =>
      f != null &&
      typeof f.exact_passage === "string" &&
      f.exact_passage.length > 10 &&
      ["stat", "quote", "claim"].includes(f.type)
  );

  // Fix #2: drop any fact whose "verbatim" passage doesn't actually appear
  // in the page text. The model sometimes paraphrases or invents the passage,
  // which would pollute the facts library and cause downstream verification
  // failures. Catching it here means the generator only sees grounded facts.
  const grounded = wellFormed.filter((f) => fuzzyMatch(page.plainText, f.exact_passage));

  return grounded.map((f) => ({
    source_url: page.url,
    exact_passage: f.exact_passage,
    retrieved_at: page.fetched_at,
    type: f.type,
    number: f.number,
  }));
}
