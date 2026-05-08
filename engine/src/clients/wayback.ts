// Wayback Machine integration.
// We trigger a "Save Page Now" snapshot for every URL that passes verification,
// and store a calendar-view Wayback URL on the receipt. The trigger is
// fire-and-forget — Wayback saves can take 30-60s and we don't want to block
// article generation. The calendar URL resolves to whatever snapshots exist
// at click time, including ours once Wayback finishes processing.
//
// Why this matters: when the source URL drifts or 404s six months from now
// (which it will), the receipt still resolves to an archived copy of the
// page that contained the cited passage at generation time.

const SAVE_ENDPOINT = "https://web.archive.org/save";
const USER_AGENT =
  "Mozilla/5.0 (compatible; BylinedBot/0.1; +https://bylined.so/bot)";

export interface WaybackSnapshot {
  // Calendar URL — Wayback resolves to all known snapshots of this URL.
  wayback_url: string;
  // ISO timestamp at which we triggered the save request.
  archived_at: string;
}

// Build the calendar URL. Encoded as a wildcard "*" timestamp which means
// "all snapshots" — the page Wayback returns lets the reader pick a date.
function buildCalendarUrl(url: string): string {
  return `https://web.archive.org/web/*/${url}`;
}

// Fire a Save Page Now request without awaiting completion.
// Returns immediately with the snapshot metadata. If the save fails (rate
// limit, network), we still return a calendar URL pointing at any existing
// snapshots Wayback may have from previous crawls.
export function snapshotUrl(url: string): WaybackSnapshot {
  fetch(`${SAVE_ENDPOINT}/${url}`, {
    method: "GET",
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    redirect: "follow",
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[wayback] save trigger failed for ${url}: ${msg}`);
  });

  return {
    wayback_url: buildCalendarUrl(url),
    archived_at: new Date().toISOString(),
  };
}

// Snapshot a list of URLs concurrently, deduping. Returns a Map keyed by URL.
export function snapshotMany(urls: string[]): Map<string, WaybackSnapshot> {
  const unique = new Set(urls);
  const out = new Map<string, WaybackSnapshot>();
  for (const url of unique) {
    out.set(url, snapshotUrl(url));
  }
  return out;
}
