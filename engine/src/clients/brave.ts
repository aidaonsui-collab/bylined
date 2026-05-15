// Brave Search API client — paid, reliable, designed for programmatic
// use. We use it as the grounding layer for the AI-visibility audit:
// each buyer question hits Brave, top results become the LLM context.
//
// Free tier: 2,000 queries/month at 1 QPS. Paid: $5 per 1,000 after.
// For Bylined the audit costs 5 queries per run, so the free tier
// covers ~400 audits/month — fine for the demo CTA volume.
//
// Why not DuckDuckGo: their HTML endpoint is rate-limited and aggressively
// IP-blocks cloud providers (Railway etc.), so the audit returned empty
// contexts and the LLM said "I have no specific businesses to recommend."
// Brave's a real API with a clean JSON response and no anti-bot gauntlet.
//
// Returns the same SerpResult shape as ddg.ts so audit.ts doesn't care
// which provider is in use.

import { logCost } from "../cost.js";
import type { SerpResult } from "../types.js";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export function hasBraveSearchKey(): boolean {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY);
}

export async function searchBrave(
  query: string,
  count = 8
): Promise<SerpResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY not set in env");
  }

  const startedAt = Date.now();
  const url = new URL(ENDPOINT);
  url.searchParams.set("q", query);
  // Brave caps at 20; we ask for what audit.ts wants.
  url.searchParams.set("count", String(Math.min(count, 20)));
  // Plain web results — no news/video/discussions sub-results in the
  // top-level response.
  url.searchParams.set("result_filter", "web");

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Subscription-Token": apiKey,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brave Search ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as BraveResponse;
  const raw = data.web?.results ?? [];

  const results: SerpResult[] = raw
    .filter((r) => r.url?.startsWith("http") && r.title)
    .slice(0, count)
    .map((r, i) => ({
      url: r.url,
      title: r.title,
      description: r.description,
      rank: i + 1,
    }));

  logCost({
    event_type: "serp_fetch",
    provider: "brave",
    duration_ms: Date.now() - startedAt,
    metadata: { query, query_count: 1, returned: results.length },
  });

  return results;
}
