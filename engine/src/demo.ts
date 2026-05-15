// Demo pipeline support — turn a visitor's homepage URL into one
// concrete SEO keyword the engine can generate against.
//
// The marketing site's "watch it write your first article" hook hands
// us a raw URL. The article generator wants a keyword. This bridges the
// gap: crawl the homepage, hand the text to the LLM, ask for the single
// keyword this business should publish about to get found by AI search.

import { fetchPage } from "./fetcher.js";
import { chatJSON } from "./clients/minimax.js";

export interface InferredTopic {
  keyword: string;
  site_summary: string;
}

const SYSTEM_PROMPT = `You analyze a business's homepage and pick ONE specific, high-intent SEO keyword they should publish an article about — the kind of query their future customers type into Google or ask ChatGPT.

Rules for the keyword:
- Specific and long-tail, not a single broad word. Good: "best project management software for construction teams". Bad: "software".
- Commercial or informational intent — something a buyer actually searches.
- Grounded in what THIS business actually does, based on the homepage text.
- 4–10 words.

Return JSON in this exact shape:
{
  "keyword": "<the one keyword>",
  "site_summary": "<one plain sentence: what this business does>"
}`;

// Crawl the homepage and infer a keyword + one-line summary. Throws on
// an unreachable site or an empty page so the worker can mark the demo
// failed with a useful message.
export async function inferKeywordFromSite(
  homepage: string
): Promise<InferredTopic> {
  const page = await fetchPage(homepage, 15000, { costType: "page_fetch" });
  const text = page.plainText.slice(0, 5000);
  if (text.length < 120) {
    throw new Error(
      "That site didn't return enough text to analyze. Try a different page."
    );
  }

  const hostname = (() => {
    try {
      return new URL(homepage).hostname;
    } catch {
      return homepage;
    }
  })();

  const result = await chatJSON<InferredTopic>(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Homepage of ${hostname}` +
          (page.title ? ` (title: "${page.title}")` : "") +
          `:\n\n${text}\n\nReturn the JSON.`,
      },
    ],
    // MiniMax-M2.7 is a reasoning model — it spends tokens thinking
    // before the JSON, so a tight cap truncates it (finish_reason=length).
    // 2000 matches what the voice fingerprint extractor uses.
    { max_tokens: 2000, costType: "llm_other" }
  );

  if (!result?.keyword || result.keyword.trim().length < 3) {
    throw new Error("Could not infer a keyword from that site.");
  }
  return {
    keyword: result.keyword.trim(),
    site_summary: (result.site_summary ?? "").trim(),
  };
}
