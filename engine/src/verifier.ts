import { fetchPage } from "./fetcher.js";
import type { VerificationResult } from "./types.js";

// Normalize for fuzzy matching: lowercase, collapse whitespace, fold smart quotes.
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim();
}

// Returns true if `needle` appears in `haystack` allowing for minor whitespace
// or punctuation drift. Falls back to chunk-overlap for longer strings.
export function fuzzyMatch(haystack: string, needle: string): boolean {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (n.length < 10) return false;
  if (h.includes(n)) return true;

  if (n.length < 30) return false;
  const chunkSize = 50;
  const chunkCount = Math.ceil(n.length / chunkSize);
  let hits = 0;
  for (let i = 0; i < chunkCount; i++) {
    const chunk = n.slice(i * chunkSize, (i + 1) * chunkSize);
    if (chunk.length >= 25 && h.includes(chunk)) hits++;
  }
  return hits / chunkCount >= 0.85;
}

// Pull every numeric token from a string. Returns clean digit strings —
// commas stripped, currency/percent/unit symbols ignored. "$1,234.5/mo" → "1234.5".
export function extractAllNumbers(text: string): string[] {
  const matches = text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g);
  return Array.from(matches, (m) => m[0].replace(/,/g, ""));
}

export async function verifyClaim(args: {
  url: string;
  exact_quote_used: string;
  expected_number?: string;
}): Promise<VerificationResult> {
  let page;
  try {
    page = await fetchPage(args.url);
  } catch (e) {
    return {
      passed: false,
      reason: "url_unreachable",
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  if (page.status >= 400) {
    return { passed: false, reason: "url_unreachable", detail: `HTTP ${page.status}` };
  }

  if (!fuzzyMatch(page.plainText, args.exact_quote_used)) {
    return {
      passed: false,
      reason: "passage_not_found",
      detail: `Quote not found at URL after fetching ${page.plainText.length} chars of body text.`,
    };
  }

  if (args.expected_number) {
    // Extract digit-runs from BOTH expected and found. Handles:
    //   ranges like "$10 – $36"        → expected: ["10", "36"]
    //   multi-value "$16/mo, $59/mo"   → expected: ["16", "59"]
    //   units like "$45/month"         → expected: ["45"]
    //   non-numeric "Yes" / "Custom"   → expected: []  (check skipped)
    // All expected digits must appear among found. Strict: catches the case
    // where a model quotes only one endpoint of a range from the source.
    const expectedNumbers = extractAllNumbers(args.expected_number);
    if (expectedNumbers.length > 0) {
      const foundNumbers = extractAllNumbers(args.exact_quote_used);
      const foundSet = new Set(foundNumbers);
      const missing = expectedNumbers.filter((e) => !foundSet.has(e));
      if (missing.length > 0) {
        return {
          passed: false,
          reason: "number_mismatch",
          detail: `Expected ${expectedNumbers.join(",")}, missing ${missing.join(",")}. Quote had: ${
            foundNumbers.length > 0 ? foundNumbers.join(",") : "no numbers"
          }.`,
        };
      }
    }
  }

  return { passed: true };
}
