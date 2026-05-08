import { chatJSON } from "./clients/minimax.js";
import type { Fact } from "./types.js";

export interface GenerationOutput {
  title: string;
  meta_description: string;
  // Plain prose, NO [^N] markers. We insert markers post-generation based
  // on the citations array's `claim` field positions.
  body_markdown: string;
  citations: Array<{
    // Exact substring of body_markdown that this citation supports.
    claim: string;
    // Fact id from the library, e.g. "f12".
    source_id: string;
    // Verbatim contiguous substring of fact.exact_passage.
    exact_quote_used: string;
  }>;
}

const SYSTEM_PROMPT = `You write SEO articles for ecommerce and SaaS operators.

OUTPUT SCHEMA (JSON):
{
  "title": "Article title",
  "meta_description": "120-155 char SEO meta description",
  "body_markdown": "Article body in markdown. Plain prose. NO [^N] markers anywhere.",
  "citations": [
    {
      "claim": "<exact substring of body_markdown that this citation supports>",
      "source_id": "<fact id from library, e.g. f12>",
      "exact_quote_used": "<verbatim contiguous substring of fact.exact_passage>"
    }
  ]
}

CRITICAL RULES (any violation invalidates the citation):

1. Every numeric claim, named quote, and citation in your article MUST come from the facts library. DO NOT invent statistics. DO NOT paraphrase numbers.

2. exact_quote_used MUST be a CONTIGUOUS SUBSTRING of the corresponding fact's exact_passage. Copy text VERBATIM, character-for-character. Do not change words. Do not reorder. Do not combine sentences.

3. ONE citation = ONE fact. Do not assemble synthetic quotes from multiple facts.

4. The "claim" field MUST be an EXACT substring of body_markdown — copy the phrase character-for-character from your own body. Keep claim short and specific (typically 5-25 words). Pick the precise phrase the citation is for, not an entire paragraph.

5. ALIGNMENT: every NUMBER in "claim" MUST also appear in "exact_quote_used". If your claim says "$36 for every $1 spent" then exact_quote_used must contain both "36" and "1". If your claim says "44%" then exact_quote_used must contain "44". This proves the citation actually supports the claim and isn't decoratively attached.

6. body_markdown contains NO [^N] markers. The system inserts those automatically based on your citations.

EXAMPLE (good):
  body_markdown: "Email marketing delivers an average $36 return for every $1 spent, the highest ROI of any channel."
  citations: [{
    "claim": "Email marketing delivers an average $36 return for every $1 spent",
    "source_id": "f7",
    "exact_quote_used": "Email marketing delivers an average $36 return for every $1 spent."
  }]
  ✓ claim is exact substring of body
  ✓ numbers in claim (36, 1) both appear in exact_quote_used
  ✓ exact_quote_used is verbatim from fact f7's passage

EXAMPLE (bad — alignment failure):
  body_markdown: "Email delivers $36 for every $1 spent."
  citations: [{
    "claim": "Email delivers $36 for every $1 spent",
    "source_id": "f12",
    "exact_quote_used": "Klaviyo holds 41.3% of the Shopify market"
  }]
  ✗ Numbers 36 and 1 not in exact_quote_used. The cited fact doesn't support the claim.

Other rules:
- Aim for 800-1200 words.
- Use H2 (##) and H3 (###) markdown headings.
- Begin with a strong intro paragraph.
- Cite at least 8 facts; ideally 15-30.
- If a sentence has no supporting fact in the library, write it WITHOUT citing OR skip the claim.`;

export async function generateArticle(
  keyword: string,
  facts: Fact[]
): Promise<GenerationOutput> {
  const factsLibrary = facts.map((f, i) => ({
    id: `f${i + 1}`,
    type: f.type,
    exact_passage: f.exact_passage,
    number: f.number,
    source_url: f.source_url,
  }));

  const userPrompt = `Topic: ${keyword}

Facts library (cite ONLY these — exact_quote_used must be a verbatim substring of the corresponding fact's exact_passage; the numbers in your claim must appear in your exact_quote_used):
${JSON.stringify(factsLibrary, null, 2)}

Write an SEO article. Body is plain prose with no [^N] markers — citations are linked via the claim field. Each claim must be an exact substring of your body_markdown.`;

  return chatJSON<GenerationOutput>(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { max_tokens: 6000 }
  );
}
