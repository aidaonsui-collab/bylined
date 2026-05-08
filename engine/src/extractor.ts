import { chatJSON } from "./clients/minimax.js";
import { fuzzyMatch } from "./verifier.js";
import type { Fact } from "./types.js";
import type { FetchedPage } from "./fetcher.js";

const SYSTEM_PROMPT = `You extract verifiable facts from web pages. Output JSON only.

For each fact, include:
- type: "stat" (numeric or percentage), "quote" (named-source quotation), or "claim" (factual statement)
- exact_passage: the exact sentence containing the fact, copied VERBATIM from the page
- number: for type=stat, the numeric value as it appears (e.g., "41.3%", "$5M", "412")

Rules:
- DO NOT paraphrase. Copy passages verbatim, exactly as they appear in the source.
- exact_passage MUST be a contiguous substring of the page text. If you cannot find a verbatim sentence, skip the fact.
- Only extract facts that are concrete and citation-worthy.
- If a sentence contains a stat AND a quote, extract them as separate facts.
- Return at most 8 facts per page (best ones first).
- Return [] if no extractable facts exist.`;

interface RawFact {
  type: "stat" | "quote" | "claim";
  exact_passage: string;
  number?: string;
}

export async function extractFacts(page: FetchedPage): Promise<Fact[]> {
  const text = page.plainText.slice(0, 12000);
  if (text.length < 200) return [];

  const raw = await chatJSON<RawFact[] | { facts: RawFact[] }>([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `URL: ${page.url}\n\nPage text:\n${text}\n\nExtract facts as a JSON array.`,
    },
  ]);

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
