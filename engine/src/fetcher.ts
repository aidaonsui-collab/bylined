import * as cheerio from "cheerio";

export interface FetchedPage {
  url: string;
  status: number;
  fetched_at: string;
  html: string;
  plainText: string;
  title?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; BylinedBot/0.1; +https://bylined.so/bot)";

export async function fetchPage(url: string, timeoutMs = 15000): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
