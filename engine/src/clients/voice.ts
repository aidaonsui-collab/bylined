// Brand voice fingerprint — analyse a site's existing pages and extract a
// compact style profile that can be injected into the article generator's
// system prompt. The fingerprint stays small (<2KB) so it doesn't bloat
// generation calls; we cache it per-site so we only pay extraction cost once.

import { z } from "zod";
import * as cheerio from "cheerio";
import { chatJSON } from "./minimax.js";

export const VoiceFingerprintSchema = z.object({
  source_url: z.string().url(),
  generated_at: z.string(),
  pages_analyzed: z.array(z.string().url()),
  // The actual style content — what gets injected into the writer's prompt.
  tone: z.string(),
  voice_traits: z.array(z.string()),
  signature_phrases: z.array(z.string()),
  avg_sentence_length: z.number(),
  technical_level: z.enum(["beginner", "intermediate", "expert"]),
  taboo: z.array(z.string()),
  example_paragraph: z.string(),
  // User-authored, NOT extracted: who articles are for and how to frame
  // them. Threaded into the generator prompt to override the audience
  // framing implied by RAG source material. Optional — older voices and
  // freshly-extracted ones won't have it until the user fills it in.
  audience_context: z.string().optional(),
});
export type VoiceFingerprint = z.infer<typeof VoiceFingerprintSchema>;

const USER_AGENT =
  "Mozilla/5.0 (compatible; BylinedBot/0.1; +https://getbylined.com/bot)";

// Pull a handful of internal article-ish links from a site, biased toward
// blog/article paths. We only need 5-10 representative pages — more
// doesn't help fingerprint quality and burns tokens.
async function discoverPages(homepage: string, max = 8): Promise<string[]> {
  const res = await fetch(homepage, { headers: { "User-Agent": USER_AGENT } });
  const html = await res.text();
  const $ = cheerio.load(html);
  const origin = new URL(homepage).origin;

  const candidates = new Set<string>([homepage]);
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let abs: URL;
    try {
      abs = new URL(href, homepage);
    } catch {
      return;
    }
    if (abs.origin !== origin) return;
    // Skip nav junk, mailto, anchors, paginated archives, asset URLs.
    if (/\.(jpg|png|gif|svg|pdf|zip|css|js)(\?|$)/i.test(abs.pathname)) return;
    if (abs.hash) abs.hash = "";
    candidates.add(abs.toString());
  });

  // Bias toward blog-shaped paths.
  const ranked = [...candidates].sort((a, b) => {
    const score = (u: string) =>
      /\/(blog|posts|articles|writing|guides|resources)\//i.test(u) ? 1 : 0;
    return score(b) - score(a);
  });
  return ranked.slice(0, max);
}

async function fetchClean(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) return "";
  const html = await res.text();
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, svg, nav, footer, header, aside").remove();
  // Prefer <article> or <main> when present — that's the editorial body.
  const main = $("article").first().text() || $("main").first().text() || $("body").text();
  return main.replace(/\s+/g, " ").trim().slice(0, 6000);
}

const SYSTEM_PROMPT = `You analyze a brand's published writing and extract a structured "voice fingerprint."

Return JSON in this exact shape:
{
  "tone": "<one sentence describing the brand's tone, e.g. 'plainspoken, mildly irreverent, ends sections with a directional take'>",
  "voice_traits": [
    "<trait, e.g. 'uses contractions freely'>",
    "<trait, e.g. 'opens sections with a question or a stat, never a hype line'>",
    "<3–7 traits total>"
  ],
  "signature_phrases": [
    "<phrases that recur across the brand's writing — 5–10 short ones>"
  ],
  "avg_sentence_length": <integer, words>,
  "technical_level": "beginner" | "intermediate" | "expert",
  "taboo": [
    "<words/phrases this brand visibly avoids — 'unlock', 'leverage', 'best-in-class', etc., based on what's NOT in the samples>"
  ],
  "example_paragraph": "<2-3 sentence paragraph in their voice on the topic 'why we built this'>"
}

Be specific and observational. Don't recycle generic copywriting advice.`;

export async function extractFingerprint(homepage: string): Promise<VoiceFingerprint> {
  const pageUrls = await discoverPages(homepage);
  if (pageUrls.length === 0) {
    throw new Error(`No analysable pages found at ${homepage}`);
  }

  const samples = await Promise.all(
    pageUrls.map(async (u) => {
      const text = await fetchClean(u).catch(() => "");
      return { url: u, text };
    })
  );
  const usable = samples.filter((s) => s.text.length > 300);
  if (usable.length === 0) {
    throw new Error(`Pages at ${homepage} returned too little text to analyze.`);
  }

  const corpus = usable
    .map((s, i) => `=== Page ${i + 1}: ${s.url} ===\n${s.text}`)
    .join("\n\n");

  const fingerprint = await chatJSON<Omit<VoiceFingerprint, "source_url" | "generated_at" | "pages_analyzed">>([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Analyse the brand voice across these ${usable.length} pages from ${
        new URL(homepage).hostname
      }:\n\n${corpus}\n\nReturn the JSON fingerprint.`,
    },
  ], { max_tokens: 2000, costType: "llm_voice" });

  return {
    source_url: homepage,
    generated_at: new Date().toISOString(),
    pages_analyzed: usable.map((s) => s.url),
    ...fingerprint,
  };
}

// Compose a system-prompt fragment that the article generator prepends.
//
// Strong-tone version: the earlier soft phrasing ("Avoid these words",
// "~N words") was being ignored by MiniMax — a real Stripe-voice
// fingerprint produced an article using "leverage" / "seamless" /
// "robust" (all 3 in the taboo list) and an avg sentence length of
// 29 vs a target of 16. Stricter framing + explicit max + self-check
// reminder. Whether it actually helps is empirical; if the next
// scored article doesn't improve, fall back to a post-generation
// rewrite pass on taboo hits (see scorer.ts notes).
export function voicePromptFragment(fp: VoiceFingerprint): string {
  const target = fp.avg_sentence_length;
  // Loose ceiling: any sentence over 1.5× target is too long. For a
  // target of 16 that's 24 — generous; tightens naturally as fingerprint
  // shortens.
  const sentMax = Math.round(target * 1.5);
  // Audience block goes FIRST and is framed as an override — the
  // generator otherwise inherits the audience/framing of whatever RAG
  // sources it was given (e.g. a "talk to your colorist in Spanish"
  // keyword pulls Spanish-tourist phrasebook sources and the article
  // comes out written for a tourist instead of a bilingual local).
  const audienceBlock = fp.audience_context
    ? `AUDIENCE & FRAMING — who this article is for. This OVERRIDES any audience or framing implied by your source material. If a source reads like it was written for a different reader (a tourist, a different region, a different expertise level), discard its framing and write for the audience described here:
${fp.audience_context}

`
    : "";
  return `${audienceBlock}BRAND VOICE — match this style. These rules sit ALONGSIDE the citation rules, not below them.

- Tone: ${fp.tone}
- Voice traits: ${fp.voice_traits.join("; ")}
- Use these signature phrases naturally where they fit (don't force them): ${fp.signature_phrases.join(", ")}
- BANNED WORDS — your body_markdown must not contain ANY of these (case-insensitive). If you catch yourself reaching for one, rewrite the sentence: ${fp.taboo.join(", ")}
- Sentence length: aim for ~${target} words on average. Sentences over ${sentMax} words are a style failure — break them in two.
- Technical level: ${fp.technical_level}

Before returning JSON, scan body_markdown once for the banned words above. If you find any, rewrite that sentence and scan again.

Example paragraph in this voice (for reference, not for copying):
${fp.example_paragraph}`;
}
