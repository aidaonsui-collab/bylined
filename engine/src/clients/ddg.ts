// DuckDuckGo HTML scraper — free, no key, no card.
// Hits the no-JS HTML endpoint and parses results with cheerio.
//
// Tradeoffs vs a paid SERP API:
//   + zero cost, zero signup
//   + stable endpoint that's been around for 10+ years
//   - DDG could change the HTML structure (low frequency, but possible)
//   - rate limits exist but are not published; expect to back off if abused
//   - results are typically organic-only (no ads, no enriched data)
//
// To swap to a paid API later, replace the body of searchSerp() — the
// SerpResult[] return shape is the contract the orchestrator depends on.

import * as cheerio from "cheerio";
import { logCost } from "../cost.js";
import type { SerpResult } from "../types.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ENDPOINT = "https://html.duckduckgo.com/html/";

// DDG wraps URLs as //duckduckgo.com/l/?uddg=<encoded>&rut=...
// Pull the actual destination out of the uddg param.
function extractActualUrl(href: string | undefined): string | null {
  if (!href) return null;
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  return null;
}

export async function searchSerp(query: string, count = 10): Promise<SerpResult[]> {
  const startedAt = Date.now();
  const body = new URLSearchParams({ q: query }).toString();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo HTML ${res.status}: ${await res.text()}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const results: SerpResult[] = [];
  logCost({
    event_type: "serp_fetch",
    provider: "duckduckgo",
    duration_ms: Date.now() - startedAt,
    metadata: { query, query_count: 1 },
  });

  $(".result").each((_, el) => {
    if (results.length >= count) return false;
    const $el = $(el);
    const titleEl = $el.find(".result__a, .result__title a").first();
    const url = extractActualUrl(titleEl.attr("href"));
    const title = titleEl.text().trim();
    const description = $el.find(".result__snippet").text().trim();

    if (!url || !url.startsWith("http") || !title) return;
    if (url.includes("duckduckgo.com")) return; // skip self-references

    results.push({
      url,
      title,
      description: description || undefined,
      rank: results.length + 1,
    });
  });

  return results;
}
