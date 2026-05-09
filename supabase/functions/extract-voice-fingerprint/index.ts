// extract-voice-fingerprint
//
// Crawls 5–8 representative pages from a homepage, sends the text corpus
// to Minimax with a structured-JSON prompt, and inserts the resulting
// VoiceFingerprint into public.voices. Returns the row to the caller.
//
// This mirrors engine/src/clients/voice.ts almost line for line — kept
// inlined here because edge functions can't import from anywhere else
// in the repo. The HTML cleaning is regex-based instead of cheerio so
// it runs in Deno without npm: imports.
//
// Wall-clock budget: ~30–60s end-to-end (8 page fetches in parallel +
// one Minimax call). Comfortably inside Supabase's 400s edge function
// timeout.
//
// Required env (Supabase Edge Function secrets):
//   MINIMAX_API_KEY  — set in Project Settings → Edge Functions → Secrets

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MINIMAX_API_KEY = Deno.env.get("MINIMAX_API_KEY") ?? "";
const MINIMAX_BASE_URL =
  Deno.env.get("MINIMAX_BASE_URL") ?? "https://api.minimaxi.chat/v1";
const MINIMAX_MODEL = Deno.env.get("MINIMAX_MODEL") ?? "MiniMax-Text-01";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const USER_AGENT =
  "Mozilla/5.0 (compatible; BylinedBot/0.1; +https://bylined.so/bot)";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ─── Tiny HTML helpers (no cheerio in Deno) ───────────────────────────

// Pull href values out of <a ...href="..."> tags. Captures both single
// and double quoted forms.
function extractHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1] ?? m[2];
    if (href) out.push(href);
  }
  return out;
}

// Strip <script>, <style>, common chrome blocks, then collapse remaining
// HTML to plain text. Prefers <article> or <main> if present.
function htmlToText(html: string): string {
  // Remove blocks we never want.
  let s = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, " ")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, " ")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, " ")
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, " ")
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, " ");

  // Prefer the inner content of <article> or <main>.
  const article = s.match(
    /<article\b[^<]*(?:(?!<\/article>)<[^<]*)*<\/article>/i
  );
  const main = s.match(/<main\b[^<]*(?:(?!<\/main>)<[^<]*)*<\/main>/i);
  if (article) s = article[0];
  else if (main) s = main[0];

  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode a couple common entities, collapse whitespace, slice.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, 6000);
}

// ─── Page discovery + fetching ─────────────────────────────────────────

async function discoverPages(homepage: string, max = 8): Promise<string[]> {
  const res = await fetch(homepage, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Could not fetch ${homepage}: HTTP ${res.status}`);
  }
  const html = await res.text();
  const origin = new URL(homepage).origin;

  const candidates = new Set<string>([homepage]);
  for (const href of extractHrefs(html)) {
    let abs: URL;
    try {
      abs = new URL(href, homepage);
    } catch {
      continue;
    }
    if (abs.origin !== origin) continue;
    if (/\.(jpg|png|gif|svg|pdf|zip|css|js)(\?|$)/i.test(abs.pathname)) continue;
    abs.hash = "";
    candidates.add(abs.toString());
  }

  const ranked = [...candidates].sort((a, b) => {
    const score = (u: string) =>
      /\/(blog|posts|articles|writing|guides|resources)\//i.test(u) ? 1 : 0;
    return score(b) - score(a);
  });
  return ranked.slice(0, max);
}

async function fetchClean(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return "";
    return htmlToText(await res.text());
  } catch {
    return "";
  }
}

// ─── Minimax JSON chat ─────────────────────────────────────────────────

interface MinimaxResp {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  base_resp?: { status_code: number; status_msg: string };
}

async function chatJSON<T>(
  systemPrompt: string,
  userPrompt: string
): Promise<T> {
  const augmentedUser =
    userPrompt +
    "\n\nRespond with valid JSON only. No prose, no markdown, no code fences.";

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${MINIMAX_BASE_URL}/text/chatcompletion_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: augmentedUser },
        ],
        temperature: attempt === 0 ? 0.4 : 0.6,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new Error(`Minimax ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as MinimaxResp;
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(
        `Minimax error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`
      );
    }

    const raw = data.choices?.[0]?.message?.content ?? "";
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    if (cleaned) {
      try {
        return JSON.parse(cleaned) as T;
      } catch (e) {
        lastError = e;
      }
    }
  }
  throw new Error(
    `Minimax did not return valid JSON after 2 attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

// ─── The fingerprint extraction prompt ─────────────────────────────────

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

interface FingerprintCore {
  tone: string;
  voice_traits: string[];
  signature_phrases: string[];
  avg_sentence_length: number;
  technical_level: "beginner" | "intermediate" | "expert";
  taboo: string[];
  example_paragraph: string;
}

// ─── Handler ───────────────────────────────────────────────────────────

function normalizeUrl(raw: string): string {
  let u = (raw ?? "").trim();
  if (!u) throw new Error("source_url is required.");
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("source_url must use http or https.");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "/");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: CORS_HEADERS });

  try {
    if (!MINIMAX_API_KEY) {
      return jsonResponse(500, {
        error:
          "MINIMAX_API_KEY is not set in Edge Function secrets. Add it at " +
          "Project Settings → Edge Functions → Secrets.",
      });
    }

    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader)
      return jsonResponse(401, { error: "Missing authorization" });

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) return jsonResponse(401, { error: "Unauthorized" });

    const body = (await req.json().catch(() => null)) as
      | { source_url?: string }
      | null;
    if (!body?.source_url) {
      return jsonResponse(400, { error: "source_url required" });
    }

    let homepage: string;
    try {
      homepage = normalizeUrl(body.source_url);
    } catch (e) {
      return jsonResponse(400, {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // 1. Discover candidate pages.
    let pageUrls: string[] = [];
    try {
      pageUrls = await discoverPages(homepage);
    } catch (e) {
      return jsonResponse(200, {
        ok: false,
        error: `Could not crawl ${homepage}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
    if (pageUrls.length === 0) {
      return jsonResponse(200, {
        ok: false,
        error: `No analysable pages found at ${homepage}.`,
      });
    }

    // 2. Fetch each page in parallel; keep only the ones that came back
    //    with enough text to actually fingerprint against.
    const samples = await Promise.all(
      pageUrls.map(async (u) => ({ url: u, text: await fetchClean(u) }))
    );
    const usable = samples.filter((s) => s.text.length > 300);
    if (usable.length === 0) {
      return jsonResponse(200, {
        ok: false,
        error:
          "Pages came back but had too little text to fingerprint. Try a " +
          "URL that's an actual article or blog homepage.",
      });
    }

    // 3. Hand the corpus to Minimax for analysis.
    const corpus = usable
      .map((s, i) => `=== Page ${i + 1}: ${s.url} ===\n${s.text}`)
      .join("\n\n");
    const userPrompt =
      `Analyse the brand voice across these ${usable.length} pages from ` +
      `${new URL(homepage).hostname}:\n\n${corpus}\n\nReturn the JSON fingerprint.`;

    let core: FingerprintCore;
    try {
      core = await chatJSON<FingerprintCore>(SYSTEM_PROMPT, userPrompt);
    } catch (e) {
      return jsonResponse(200, {
        ok: false,
        error: `LLM extraction failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }

    const fingerprint = {
      source_url: homepage,
      generated_at: new Date().toISOString(),
      pages_analyzed: usable.map((s) => s.url),
      ...core,
    };

    // 4. Insert via the user-scoped client — voices has owner_full_access
    //    RLS so this lands under the calling user.
    const { data: inserted, error: insertErr } = await userClient
      .from("voices")
      .insert({
        source_url: homepage,
        fingerprint,
      })
      .select("id")
      .single();
    if (insertErr) {
      return jsonResponse(500, {
        error: `Could not save voice: ${insertErr.message}`,
      });
    }

    return jsonResponse(200, {
      ok: true,
      voice_id: inserted.id,
      pages_analyzed: usable.map((s) => s.url),
      fingerprint,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("extract-voice-fingerprint error:", msg);
    return jsonResponse(500, { error: msg });
  }
});
