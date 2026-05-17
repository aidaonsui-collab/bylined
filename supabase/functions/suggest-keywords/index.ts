// Brand-voice keyword brainstormer.
//
// Called from the keyword form's "Get suggestions" button. Feeds the
// user's voice fingerprint (tone, taboo words, signature phrases) +
// their recent article keywords (so we don't suggest duplicates) to
// MiniMax, and returns N keyword candidates with a one-line "why"
// for each. The frontend renders these as click-to-add chips that
// append to the textarea.
//
// One LLM call per invocation. Cheap (~$0.005 at MiniMax pricing for
// ~3k input + ~1k output tokens). Gated on user JWT — RLS scopes the
// voice + articles read to the caller.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MINIMAX_API_KEY = Deno.env.get("MINIMAX_API_KEY")!;
const MINIMAX_BASE_URL = Deno.env.get("MINIMAX_BASE_URL") ?? "https://api.minimaxi.chat/v1";
const MINIMAX_MODEL = Deno.env.get("MINIMAX_MODEL") ?? "MiniMax-Text-01";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

interface VoiceFingerprint {
  tone?: string;
  technical_level?: string;
  taboo?: string[];
  signature_phrases?: string[];
  voice_traits?: string[];
}

interface Suggestion {
  keyword: string;
  why: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "POST only" });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) return jsonResponse(401, { error: "Missing authorization" });

  // JWT-scoped client — RLS gates which voice + articles the caller can read.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) {
    return jsonResponse(401, { error: "Invalid session" });
  }

  let body: { voice_id?: string; count?: number } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — we'll fall back to the user's most recent voice */
  }
  // Clamp count to a reasonable range. 15 is the sweet spot for the
  // suggestion panel (one screen, no scroll).
  const count = Math.min(Math.max(body.count ?? 15, 5), 30);

  // Fetch voice: either the explicitly requested one or the latest.
  let voiceQuery = userClient
    .from("voices")
    .select("id, source_url, fingerprint")
    .order("created_at", { ascending: false })
    .limit(1);
  if (body.voice_id) {
    voiceQuery = userClient
      .from("voices")
      .select("id, source_url, fingerprint")
      .eq("id", body.voice_id)
      .limit(1);
  }
  const { data: voiceRows } = await voiceQuery;
  const voice = voiceRows?.[0];
  if (!voice) {
    return jsonResponse(400, {
      error:
        "No brand voice found. Extract one at /app/voice first so suggestions can match your style.",
    });
  }

  // Pull recent article keywords + titles to dedupe suggestions against.
  // 50 rows is plenty — past that, topics drift and the dedup signal weakens.
  const { data: recent } = await userClient
    .from("articles")
    .select("keyword, title")
    .order("generated_at", { ascending: false })
    .limit(50);

  const recentKeywords = (recent ?? [])
    .map((r: { keyword?: string }) => r.keyword)
    .filter(Boolean) as string[];
  const recentTitles = (recent ?? [])
    .map((r: { title?: string }) => r.title)
    .filter(Boolean) as string[];

  const fp = (voice.fingerprint ?? {}) as VoiceFingerprint;
  const prompt = buildPrompt({
    sourceUrl: voice.source_url ?? null,
    tone: fp.tone,
    technicalLevel: fp.technical_level,
    signaturePhrases: fp.signature_phrases ?? [],
    voiceTraits: fp.voice_traits ?? [],
    recentKeywords,
    recentTitles,
    count,
  });

  try {
    const suggestions = await callMinimax(prompt, count);
    // Belt-and-suspenders dedup against keywords the model might have
    // echoed back despite the prompt instruction.
    const seen = new Set(
      recentKeywords.map((k) => normalize(k)).concat(
        recentTitles.map((t) => normalize(t)),
      ),
    );
    const filtered = suggestions.filter(
      (s) => s.keyword && !seen.has(normalize(s.keyword)),
    );
    return jsonResponse(200, {
      ok: true,
      voice: { id: voice.id, source_url: voice.source_url },
      suggestions: filtered.slice(0, count),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("suggest-keywords error:", msg);
    return jsonResponse(500, { error: msg });
  }
});

function buildPrompt({
  sourceUrl,
  tone,
  technicalLevel,
  signaturePhrases,
  voiceTraits,
  recentKeywords,
  recentTitles,
  count,
}: {
  sourceUrl: string | null;
  tone?: string;
  technicalLevel?: string;
  signaturePhrases: string[];
  voiceTraits: string[];
  recentKeywords: string[];
  recentTitles: string[];
  count: number;
}): string {
  // Voice traits + signature phrases are signal about WHAT this brand
  // tends to write about and HOW they frame it. Recent articles ground
  // adjacency — suggestions should cluster around existing topics
  // (sibling subtopics), not drift into unrelated verticals.
  const phraseHint = signaturePhrases.slice(0, 6).join(", ");
  const traitsHint = voiceTraits.slice(0, 4).map((t) => `- ${t}`).join("\n");
  const recentHint = [...recentKeywords, ...recentTitles]
    .slice(0, 40)
    .map((s) => `- ${s}`)
    .join("\n");

  return `You're an SEO strategist suggesting keyword ideas for a brand's content pipeline.

BRAND CONTEXT
- Source site: ${sourceUrl ?? "unknown"}
- Tone: ${tone ?? "professional"}
- Reader technical level: ${technicalLevel ?? "intermediate"}
- Signature phrases (style cues): ${phraseHint || "n/a"}
${traitsHint ? `- Voice traits:\n${traitsHint}` : ""}

ALREADY COVERED (don't suggest duplicates or close variants — pick sibling subtopics):
${recentHint || "(no prior articles — green field)"}

TASK
Suggest ${count} long-tail SEO keyword ideas this brand would want to rank for. Each keyword must:
- Be 4-10 words
- Be buyer-intent or comparison-style ("how to X", "X vs Y", "X benchmarks 2026") or a deep-dive informational angle ("when to switch from X to Y")
- Stay in the SAME vertical as the existing articles — extend, don't pivot
- Have real search demand (avoid obscure jargon, inside-baseball terms)
- Be specific enough that a verified article with cited sources can be written about it

For each suggestion, write a ONE-SENTENCE "why" explaining the angle or strategic fit (e.g., "natural follow-up to your X article", "fills the gap between Y and Z topics you've covered", "buyer-stage question that AI engines are answering poorly today").

Return JSON ONLY:
{
  "suggestions": [
    { "keyword": "...", "why": "..." }
  ]
}`;
}

interface MinimaxResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  base_resp?: { status_code: number; status_msg: string };
}

async function callMinimax(prompt: string, count: number): Promise<Suggestion[]> {
  // Retry up to twice if JSON parses but the structure is wrong. Don't
  // burn an LLM call to grow max_tokens here — keyword suggestions are
  // tiny output (~50 tokens per item).
  let lastError: unknown;
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
          {
            role: "system",
            content:
              "You return JSON only. No prose before or after, no code fences.",
          },
          { role: "user", content: prompt },
        ],
        temperature: attempt === 0 ? 0.7 : 0.85,
        // count * ~60 tokens (keyword + why) + JSON wrapping + reasoning headroom
        max_tokens: Math.min(2000 + count * 60, 6000),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`MiniMax HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as MinimaxResponse;
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(
        `MiniMax error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`,
      );
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      lastError = new Error(
        `Empty response (finish_reason=${data.choices?.[0]?.finish_reason})`,
      );
      continue;
    }

    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      const parsed = JSON.parse(cleaned) as { suggestions?: Suggestion[] };
      if (Array.isArray(parsed.suggestions)) {
        return parsed.suggestions
          .filter((s) => typeof s.keyword === "string" && s.keyword.trim())
          .map((s) => ({
            keyword: s.keyword.trim().toLowerCase(),
            why: typeof s.why === "string" ? s.why.trim() : "",
          }));
      }
      lastError = new Error("JSON missing 'suggestions' array");
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `Failed to parse MiniMax suggestions: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

// Lowercase + strip whitespace/punct for dedup comparison. "ACH Return Codes"
// and "ach return codes" collapse to the same key.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
