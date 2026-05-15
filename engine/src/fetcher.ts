import * as cheerio from "cheerio";
import { logCost, type CostEventType } from "./cost.js";

export interface FetchedPage {
  url: string;
  status: number;
  fetched_at: string;
  html: string;
  plainText: string;
  title?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; BylinedBot/0.1; +https://getbylined.com/bot)";

export async function fetchPage(
  url: string,
  timeoutMs = 15000,
  opts: { costType?: CostEventType } = {}
): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    const html = await res.text();
    const $ = cheerio.load(html);

    // Strip non-content noise so plainText is matchable
    $("script, style, noscript, iframe, svg, nav, footer, header, aside").remove();
    const plainText = $("body").text().replace(/\s+/g, " ").trim();
    const title = $("title").first().text().trim();

    logCost({
      event_type: opts.costType ?? "page_fetch",
      provider: "fetch",
      duration_ms: Date.now() - startedAt,
      metadata: { url, status: res.status, bytes: html.length },
    });

    return {
      url,
      status: res.status,
      fetched_at: new Date().toISOString(),
      html,
      plainText,
      title: title || undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}
