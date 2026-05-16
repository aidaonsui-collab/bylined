// Per-article scoring heuristics.
//
// Two scores feed the in-app dashboard:
//
//   aeo_score (0-100)         — how citable the article is for LLM
//                                answer engines (ChatGPT, Perplexity,
//                                Google AI Overviews). Built from
//                                structural signals known to correlate
//                                with citation: headings, citation
//                                density, direct quotes, named stats,
//                                lists, paragraph length.
//
//   voice_match_score (0-100) — how close the prose matches the
//                                brand voice fingerprint. Sentence
//                                length proximity, signature-phrase
//                                hits, taboo penalty. NULL upstream
//                                when no voice was used.
//
// These are deliberately heuristic, not embedding-based — they need
// to run in the worker without an extra LLM/embeddings call. Good
// enough for a rolling dashboard average; not a substitute for a
// human eyeball.

import type { Article } from "./types.js";
import type { VoiceFingerprint } from "./clients/voice.js";

// ────────────────────────────────────────────────────────────────────
// AEO score
// ────────────────────────────────────────────────────────────────────

export function computeAEOScore(article: Article): number {
  const body = article.body_markdown;
  const words = countWords(body);
  if (words < 50) return 0;

  let score = 0;

  // Structural — H2 + H3 both present is a strong AEO signal.
  const h2Count = (body.match(/^##\s+/gm) ?? []).length;
  const h3Count = (body.match(/^###\s+/gm) ?? []).length;
  if (h2Count >= 2) score += 10;
  if (h3Count >= 1) score += 5;

  // Citation density — markers look like [1], [2] in body.
  const citationMarkers = body.match(/\[\d+\]/g) ?? [];
  const citationsPer1k = (citationMarkers.length / words) * 1000;
  if (citationsPer1k >= 5) score += 25;
  else if (citationsPer1k >= 3) score += 15;
  else if (citationsPer1k >= 1) score += 5;

  // Direct quotes — counted from receipts since body quotes can be
  // styled inconsistently.
  const quoteReceipts = article.receipts.filter(
    (r) => r.verified && r.type === "quote",
  ).length;
  if (quoteReceipts >= 3) score += 15;
  else if (quoteReceipts >= 1) score += 8;

  // Verified stats with numbers.
  const statReceipts = article.receipts.filter(
    (r) => r.verified && r.type === "stat",
  ).length;
  if (statReceipts >= 3) score += 20;
  else if (statReceipts >= 1) score += 10;

  // Lists give answer engines clean extractable structures.
  const bulletLines = (body.match(/^\s*[-*]\s+/gm) ?? []).length;
  const numberedLines = (body.match(/^\s*\d+\.\s+/gm) ?? []).length;
  if (bulletLines + numberedLines >= 6) score += 10;
  else if (bulletLines + numberedLines >= 3) score += 5;

  // Paragraph length sanity — wall-of-text or one-liner pulls fail
  // to land citations. 50-150 words/para is the sweet spot.
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"));
  if (paras.length >= 3) {
    const avgParaWords =
      paras.reduce((sum, p) => sum + countWords(p), 0) / paras.length;
    if (avgParaWords >= 50 && avgParaWords <= 150) score += 15;
    else if (avgParaWords >= 30 && avgParaWords <= 200) score += 8;
  }

  return clamp(Math.round(score), 0, 100);
}

// ────────────────────────────────────────────────────────────────────
// Voice-match score
// ────────────────────────────────────────────────────────────────────

export function computeVoiceMatchScore(
  article: Article,
  fingerprint: VoiceFingerprint,
): number {
  const body = stripMarkdown(article.body_markdown);
  if (body.length < 200) return 0;

  // Start at 50 so a wholly neutral article scores around the middle
  // — the bonuses/penalties tilt it from there.
  let score = 50;

  // Avg sentence length proximity to the fingerprint's own.
  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length >= 3) {
    const avgLen =
      sentences.reduce((sum, s) => sum + countWords(s), 0) / sentences.length;
    const target = fingerprint.avg_sentence_length || avgLen;
    const drift = Math.abs(avgLen - target) / target;
    if (drift <= 0.2) score += 20;
    else if (drift <= 0.4) score += 10;
    else if (drift >= 0.7) score -= 10;
  }

  // Signature-phrase hits — capped so a one-trick keyword stuff
  // doesn't max out the score.
  const lower = body.toLowerCase();
  const sigHits = fingerprint.signature_phrases
    .filter((p) => p && p.length >= 3)
    .filter((p) => lower.includes(p.toLowerCase())).length;
  score += Math.min(sigHits, 4) * 4;

  // Taboo penalty — taboo phrases the brand explicitly avoids.
  const tabooHits = fingerprint.taboo
    .filter((p) => p && p.length >= 3)
    .filter((p) => lower.includes(p.toLowerCase())).length;
  if (tabooHits >= 2) score -= 30;
  else if (tabooHits === 1) score -= 10;

  // Technical-level sanity — beginner voices that produce
  // jargon-heavy prose, or vice versa, get a small tug.
  if (fingerprint.technical_level === "beginner" && containsJargon(body)) {
    score -= 8;
  }
  if (fingerprint.technical_level === "expert" && !containsJargon(body)) {
    score -= 5;
  }

  return clamp(Math.round(score), 0, 100);
}

// ────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[(\d+)\]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~]/g, " ");
}

// Very rough "does this read like expert-level prose" check. Looks
// for hyphenated technical compounds, acronyms in CAPS, and
// long-tail multi-syllable density. Not perfect — good enough for a
// dashboard tug.
function containsJargon(text: string): boolean {
  const acronyms = (text.match(/\b[A-Z]{3,}\b/g) ?? []).length;
  const hyphenated = (text.match(/\b\w+-\w+(-\w+)?\b/g) ?? []).length;
  const words = countWords(text);
  if (words === 0) return false;
  return (acronyms + hyphenated) / words > 0.015;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
