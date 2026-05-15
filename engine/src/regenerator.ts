// Second-chance citation lookup. When the main generator produces a
// claim whose chosen source doesn't actually support it (gate 2-5
// failure), we ask Minimax once more — with a tighter prompt — whether
// any *other* fact in the library backs the same claim. If yes, the
// retry citation goes through the same verification gates as the
// original. If no, the claim gets dropped.
//
// Distinct from generator.ts because the prompt is narrower: no
// article-writing, no style guidance, no body — just "find or fail."

import { chatJSON } from "./clients/minimax.js";
import type { Fact } from "./types.js";

export interface RetryCitationOutput {
  // f-id of a fact that supports the claim, or null if nothing does
  source_id: string | null;
  // Verbatim contiguous substring of the chosen fact's exact_passage
  exact_quote_used: string | null;
}

const RETRY_PROMPT = `You are auditing a single citation that failed verification. Given a claim from an article and a library of facts, find ONE fact whose passage SUPPORTS the claim verbatim.

Rules:
- "exact_quote_used" MUST be a verbatim contiguous substring of the chosen fact's exact_passage. Copy character-for-character.
- Every NUMBER in the claim MUST appear in exact_quote_used. If the claim says "44%", exact_quote_used must contain "44".
- If NO fact in the library genuinely supports the claim with a verbatim phrase, return { "source_id": null, "exact_quote_used": null }. Do NOT force a citation that doesn't hold up.

OUTPUT (JSON only):
{ "source_id": "f12", "exact_quote_used": "..." }
or
{ "source_id": null, "exact_quote_used": null }`;

export async function retryCitation(
  claim: string,
  facts: Fact[]
): Promise<RetryCitationOutput | null> {
  // Trim the facts library to keep prompt size reasonable. The retry
  // only ever runs on a handful of failed claims so per-call cost is
  // small even at max library size.
  const factsLibrary = facts.map((f, i) => ({
    id: `f${i + 1}`,
    exact_passage: f.exact_passage,
    number: f.number,
  }));

  const userPrompt = `Claim to support: "${claim}"

Facts library:
${JSON.stringify(factsLibrary, null, 2)}

Return the JSON.`;

  try {
    const out = await chatJSON<RetryCitationOutput>(
      [
        { role: "system", content: RETRY_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { max_tokens: 600, costType: "llm_other" }
    );
    return out;
  } catch {
    return null;
  }
}
