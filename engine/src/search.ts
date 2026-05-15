// Search dispatcher. Both the audit and the article-generation
// orchestrator need web search; both hit the same Railway-IP problem
// when relying on the free DDG HTML scraper (DDG aggressively
// rate-limits / IP-blocks cloud providers, returning empty pages).
// This module picks Brave Search when BRAVE_SEARCH_API_KEY is set
// (production), and falls back to DDG for local dev so contributors
// without a key can still run things.

import { searchSerp } from "./clients/ddg.js";
import { searchBrave, hasBraveSearchKey } from "./clients/brave.js";
import type { SerpResult } from "./types.js";

export function search(query: string, count = 10): Promise<SerpResult[]> {
  if (hasBraveSearchKey()) return searchBrave(query, count);
  return searchSerp(query, count);
}

export { hasBraveSearchKey };
