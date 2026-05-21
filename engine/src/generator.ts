import { chatJSON } from "./clients/minimax.js";
import { voicePromptFragment, type VoiceFingerprint } from "./clients/voice.js";
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
  "body_markdown": "Article body in markdown — headings, paragraphs, and lists. NO [^N] markers anywhere.",
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

7. NEVER write ABOUT your sources. State facts directly. The body must not name, describe, rate, or promote the websites, apps, or documents your facts came from — the citation system attributes sources separately, the prose never does. A source's self-description ("the world's most popular X", "a comprehensive guide to Y") is NOT a fact about your topic — never reproduce it.
   BAD: "SpanishDictionary.com is the world's most popular Spanish-English dictionary."
   BAD: "A resource listing 200+ salon phrases confirms this."
   GOOD: state the fact on its own — "The Spanish word for colorist is colorista."

8. RELEVANCE OVER LENGTH. The facts library is a menu, not a checklist — use ONLY the facts that help the reader do the specific thing the title promises. A fact can be accurate, well-sourced, and still not belong: if it does not serve the reader's actual goal, leave it out. Never add a section just to reach the word count. If you catch yourself writing "this won't come up", "though you may not need this", or similar hedges — delete that section entirely. A tight 900-word article with zero filler beats a padded 1300-word one. The word range in LENGTH & CITATIONS below is a ceiling for RELEVANT material, not a quota to fill.

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

ARTICLE STRUCTURE (write body_markdown in exactly this order — this is how AI answer engines decide whether to cite you):

1. DIRECT ANSWER FIRST. The opening paragraph (2-4 sentences) must directly and completely answer the implied question of the topic. It must be self-contained — quotable on its own with zero setup. NO throat-clearing ("In today's landscape...", "Businesses everywhere...", "As the market evolves..."). Sentence one answers the question.

2. KEY TAKEAWAYS. Immediately after the opening paragraph, write a line that is exactly "**Key takeaways:**" then 3-5 markdown bullet points ("- "), each one scannable sentence capturing a core point.

3. BODY SECTIONS. Then the main content under H2 headings (##). Phrase H2 headings as the actual questions a reader would ask ("How does X work?", "What does Y cost?", "When should you use Z?") — not bare labels ("Overview", "Pricing", "Benefits"). Use H3 (###) for sub-points. Within sections, use bulleted or numbered lists for any set of steps, criteria, examples, or comparisons — AI engines extract structured lists far more readily than walls of prose. Include at least 3 lists across the article.

4. FAQ SECTION. End the article with an H2 heading exactly "## Frequently Asked Questions", followed by 3-5 question/answer pairs. Each question is an H3 heading (### ...) ending with "?". Each answer is 1-3 sentences in a paragraph directly below its question. Make these genuine follow-up questions a reader would ask — distinct from the H2 section headings above.

LENGTH & CITATIONS:
- Main body: 900-1300 words, plus the Key takeaways list and the FAQ section.
- Cite at least 8 facts; ideally 15-30. Citations may appear anywhere in body_markdown — the opening answer, body sections, and FAQ answers all count.
- If a sentence has no supporting fact in the library, write it WITHOUT citing OR skip the claim. Never invent a citation to satisfy the structure.`;

export async function generateArticle(
  keyword: string,
  facts: Fact[],
  voice?: VoiceFingerprint
): Promise<GenerationOutput> {
  const factsLibrary = facts.map((f, i) => ({
    id: `f${i + 1}`,
    type: f.type,
    exact_passage: f.exact_passage,
    number: f.number,
    source_url: f.source_url,
  }));

  // If a brand voice is provided, prepend its prompt fragment to the system
  // prompt. Citation rules still take priority — voice adapts style only.
  const systemContent = voice
    ? `${voicePromptFragment(voice)}\n\n${SYSTEM_PROMPT}`
    : SYSTEM_PROMPT;

  const userPrompt = `Topic: ${keyword}

Facts library (cite ONLY these — exact_quote_used must be a verbatim substring of the corresponding fact's exact_passage; the numbers in your claim must appear in your exact_quote_used):
${JSON.stringify(factsLibrary, null, 2)}

Write an SEO article. Body is plain prose with no [^N] markers — citations are linked via the claim field. Each claim must be an exact substring of your body_markdown.`;

  return chatJSON<GenerationOutput>(
    [
      { role: "system", content: systemContent },
      { role: "user", content: userPrompt },
    ],
    // 8000 = ~3000 tokens for reasoning + ~5000 for the JSON envelope
    // (1200-word article + citations array). chatJSON grows this 1.5×
    // per retry if MiniMax still truncates.
    { max_tokens: 8000, costType: "llm_generation" }
  );
}
